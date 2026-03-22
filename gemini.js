import WebSocket from 'ws';
import { v4 as uuid } from 'uuid';
import { config, logger, logClient, logGemini } from './config.js';
import { sipMap, cleanupPromises } from './state.js';
import { streamAudio, rtpEvents } from './rtp.js';

logger.info('Loading gemini.js module');

// Convert 24kHz 16-bit PCM to 8kHz g711 μ-law
function convert24kHzPCMTo8kHzULaw(buffer24kHz) {
  const length8kHz = Math.floor(buffer24kHz.length / 6); // 3 samples of 16-bit (6 bytes) to 1 sample of 8kHz
  const buffer8kHz = Buffer.alloc(length8kHz * 2); // 16-bit PCM at 8kHz

  // Downsample from 24kHz to 8kHz with simple averaging to prevent aliasing
  for (let i = 0; i < length8kHz; i++) {
    const sourceIndex = i * 6;
    const s1 = buffer24kHz.readInt16LE(sourceIndex);
    const s2 = buffer24kHz.readInt16LE(sourceIndex + 2);
    const s3 = buffer24kHz.readInt16LE(sourceIndex + 4);

    const sample = Math.round((s1 + s2 + s3) / 3);
    buffer8kHz.writeInt16LE(sample, i * 2);
  }

  // Convert 16-bit PCM to g711 μ-law
  return pcmToULaw(buffer8kHz);
}

// Convert 16-bit PCM to g711 μ-law
function pcmToULaw(pcmBuffer) {
  const ulawBuffer = Buffer.alloc(pcmBuffer.length / 2);
  const BIAS = 0x84;
  const MAX = 32635;

  for (let i = 0; i < ulawBuffer.length; i++) {
    let sample = pcmBuffer.readInt16LE(i * 2);
    let sign = 0;

    if (sample < 0) {
      sign = 0x80;
      sample = -sample;
    }

    if (sample > MAX) sample = MAX;
    sample += BIAS;

    let exponent = 7;
    for (let exp = 0; exp < 8; exp++) {
      if (sample <= (0x1F << (exp + 3))) {
        exponent = exp;
        break;
      }
    }

    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    ulawBuffer[i] = ~(sign | (exponent << 4) | mantissa);
  }

  return ulawBuffer;
}

async function waitForBufferEmpty(channelId, maxWaitTime = 5000, checkInterval = 10) {
  const channelData = sipMap.get(channelId);
  if (!channelData?.streamHandler) {
    logGemini(`No streamHandler for ${channelId}, proceeding`, 'info');
    return true;
  }
  const streamHandler = channelData.streamHandler;
  const startWaitTime = Date.now();

  let audioDurationMs = 1000; // Default minimum
  if (channelData.totalDeltaBytes) {
    audioDurationMs = Math.ceil((channelData.totalDeltaBytes / 8000) * 1000) + 500; // Audio duration + 500ms margin
  }
  const dynamicTimeout = Math.min(audioDurationMs, maxWaitTime);
  logGemini(`Using dynamic timeout of ${dynamicTimeout}ms for ${channelId} (estimated audio duration: ${(channelData.totalDeltaBytes || 0) / 8000}s)`, 'info');

  let audioFinishedReceived = false;
  const audioFinishedPromise = new Promise((resolve) => {
    rtpEvents.once('audioFinished', (id) => {
      if (id === channelId) {
        logGemini(`Audio finished sending for ${channelId} after ${Date.now() - startWaitTime}ms`, 'info');
        audioFinishedReceived = true;
        resolve();
      }
    });
  });

  const isBufferEmpty = () => (
    (!streamHandler.audioBuffer || streamHandler.audioBuffer.length === 0) &&
    (!streamHandler.packetQueue || streamHandler.packetQueue.length === 0)
  );
  if (!isBufferEmpty()) {
    let lastLogTime = 0;
    while (!isBufferEmpty() && (Date.now() - startWaitTime) < maxWaitTime) {
      const now = Date.now();
      if (now - lastLogTime >= 50) {
        logGemini(`Waiting for RTP buffer to empty for ${channelId} | Buffer: ${streamHandler.audioBuffer?.length || 0} bytes, Queue: ${streamHandler.packetQueue?.length || 0} packets`, 'info');
        lastLogTime = now;
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    if (!isBufferEmpty()) {
      logger.warn(`Timeout waiting for RTP buffer to empty for ${channelId} after ${maxWaitTime}ms`);
      return false;
    }
    logGemini(`RTP buffer emptied for ${channelId} after ${Date.now() - startWaitTime}ms`, 'info');
  }

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      if (!audioFinishedReceived) {
        logger.warn(`Timeout waiting for audioFinished for ${channelId} after ${dynamicTimeout}ms`);
      }
      resolve();
    }, dynamicTimeout);
  });
  await Promise.race([audioFinishedPromise, timeoutPromise]);

  logGemini(`waitForBufferEmpty completed for ${channelId} in ${Date.now() - startWaitTime}ms`, 'info');
  return true;
}

async function startGeminiWebSocket(channelId) {
  const GEMINI_API_KEY = config.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    logger.error('GEMINI_API_KEY is missing in config');
    throw new Error('Missing GEMINI_API_KEY');
  }

  let channelData = sipMap.get(channelId);
  if (!channelData) {
    throw new Error(`Channel ${channelId} not found in sipMap`);
  }

  let normalizedModel = config.GEMINI_MODEL || 'models/gemini-2.5-flash-native-audio-preview-12-2025';
  if (!normalizedModel.startsWith('models/')) {
    normalizedModel = `models/${normalizedModel}`;
  }

  channelData.geminiModel = normalizedModel;

  let ws;
  let streamHandler = null;
  let retryCount = 0;
  const maxRetries = 3;
  let isResponseActive = false;
  let totalDeltaBytes = 0;
  let loggedDeltaBytes = 0;
  let segmentCount = 0;
  let responseBuffer = Buffer.alloc(0);
  let messageQueue = [];
  let itemRoles = new Map();
  let lastUserItemId = null;

  const processMessage = async (response) => {
    try {
      if (response.setupComplete) {
        logGemini(`Setup complete for ${channelId}`);
        if (channelData && typeof channelData.setupDoneResolve === 'function') {
          channelData.setupDoneResolve();
          delete channelData.setupDoneResolve;
        }
      } else if (response.serverContent) {
        const serverContent = response.serverContent;
        if (serverContent.modelTurn) {
          logGemini.debug(`Model turn received for ${channelId}`);
          channelData.geminiResponseInProgress = true;
          sipMap.set(channelId, channelData);
          if (serverContent.modelTurn.parts) {
            let hasAudio = false;
            for (const part of serverContent.modelTurn.parts) {
              const audioBase64 = part.audio?.data || part.inlineData?.data || part.inline_data?.data;
              if (audioBase64) {
                hasAudio = true;
                logGemini.debug(`Audio part found! Data length: ${(audioBase64 && audioBase64.length) ? audioBase64.length : 'undefined'} bytes`, 'info');
                const audioBuffer = Buffer.from(audioBase64, 'base64');
                if (audioBuffer.length > 0) {
                  totalDeltaBytes += audioBuffer.length;
                  channelData.totalDeltaBytes = totalDeltaBytes;
                  sipMap.set(channelId, channelData);
                  segmentCount++;
                  logGemini.debug(`Received audio: ${audioBuffer.length} bytes, total: ${totalDeltaBytes} bytes, estimated duration: ${(totalDeltaBytes / 48000).toFixed(2)}s`, 'info');

                  if (sipMap.has(channelId) && streamHandler) {
                    responseBuffer = Buffer.concat([responseBuffer, audioBuffer]);
                    const bytesToProcess = Math.floor(responseBuffer.length / 6) * 6;
                    if (bytesToProcess > 0) {
                      const chunkToProcess = responseBuffer.slice(0, bytesToProcess);
                      responseBuffer = responseBuffer.slice(bytesToProcess);
                      const convertedBuffer = convert24kHzPCMTo8kHzULaw(chunkToProcess);
                      streamHandler.sendRtpPacket(convertedBuffer);
                    }
                  }
                }
              } else if (part.text) {
                logGemini(`Model text received: ${part.text.trim()}`, 'info');
              }
            }
            if (!hasAudio) {
              logGemini(`No audio parts in modelTurn, parts count: ${serverContent.modelTurn.parts.length}`, 'warn');
            }
          }
          if (serverContent.generationComplete) {
            logGemini(`Generation complete for ${channelId}`);
          }
          if (serverContent.turnComplete || serverContent.generationComplete) {
            logGemini(`Turn/generation complete for ${channelId}`);
            isResponseActive = false;
            channelData.geminiResponseDone = true;
            channelData.geminiResponseInProgress = false;
            sipMap.set(channelId, channelData);
            loggedDeltaBytes = 0;
            segmentCount = 0;
            itemRoles.clear();
            lastUserItemId = null;
            responseBuffer = Buffer.alloc(0);
          }
          if (serverContent.interrupted) {
            logGemini(`Response interrupted for ${channelId}`);
            isResponseActive = false;
          }
        }
      } else if (response.inputTranscription) {
        if (response.inputTranscription.text) {
          logGemini(`User input transcription for ${channelId}: ${response.inputTranscription.text}`, 'info');
        }
      } else if (response.outputTranscription) {
        if (response.outputTranscription.text) {
          logGemini(`Model output transcription for ${channelId}: ${response.outputTranscription.text}`, 'info');
        }
      } else if (response.goAway) {
        logger.warn(`Gemini server shutting down for ${channelId}, time left: ${response.goAway.timeLeft}ms`);
        ws.close();
      } else {
        logger.debug(`Unhandled message type for ${channelId}: ${Object.keys(response).join(', ')}`, { response });
      }
    } catch (e) {
      logger.error(`Error processing message for ${channelId}: ${e.message}`);
    }
  };

  const connectWebSocket = () => {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(config.REALTIME_URL);

      ws.on('open', async () => {
        logClient(`Gemini WebSocket connected for ${channelId}`);

        const setupDonePromise = new Promise((resolve) => {
          channelData.setupDoneResolve = resolve;
        });

        // Send setup message first
        ws.send(JSON.stringify({
          setup: {
            model: channelData.geminiModel,
            systemInstruction: {
              parts: [{ text: config.SYSTEM_PROMPT }]
            },
            realtimeInputConfig: {
              automaticActivityDetection: {
                disabled: false,
                startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
                endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
                prefixPaddingMs: config.VAD_PREFIX_PADDING_MS,
                silenceDurationMs: config.VAD_SILENCE_DURATION_MS
              },
              activityHandling: "NO_INTERRUPTION"
            },
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: config.GEMINI_VOICE
                  }
                }
              }
            },
            outputAudioTranscription: {}
          }
        }));
        logClient(`Setup sent for ${channelId}`);

        try {
          // Wait for setup confirmation (setupComplete) before sending user content
          await Promise.race([
            setupDonePromise,
            new Promise((_, rejectSetup) => setTimeout(() => rejectSetup(new Error('Gemini setup timeout')), 12000))
          ]);

          const rtpSource = channelData.rtpSource || { address: '127.0.0.1', port: 12000 };
          streamHandler = await streamAudio(channelId, rtpSource);
          channelData.ws = ws;
          channelData.streamHandler = streamHandler;
          channelData.totalDeltaBytes = 0;
          sipMap.set(channelId, channelData);

          // Gemini にテキスト起動リクエストを送信して初回応答をトリガー
          ws.send(JSON.stringify({
            clientContent: {
              turns: [{ role: 'user', parts: [{ text: config.INITIAL_MESSAGE || '音声応答を開始してください' }] }],
              turnComplete: true
            }
          }));

          logClient(`Waiting for user audio input for ${channelId}`);
          isResponseActive = false;
          resolve(ws);
        } catch (e) {
          logger.error(`Error setting up WebSocket for ${channelId}: ${e.message}`);
          ws.close();
          reject(e);
        }
      });

      ws.on('message', (data) => {
        try {
          const response = JSON.parse(data.toString());
          logger.debug(`Raw WebSocket message for ${channelId}: ${JSON.stringify(response, null, 2)}`);
          messageQueue.push(response);
          logGemini(`WebSocket message received (queue size: ${messageQueue.length})`, 'debug');
        } catch (e) {
          logger.error(`Error parsing WebSocket message for ${channelId}: ${e.message}`);
        }
      });

      ws.on('error', (e) => {
        logger.error(`WebSocket error for ${channelId}: ${e.message}`);
        if (retryCount < maxRetries && sipMap.has(channelId)) {
          retryCount++;
          setTimeout(() => connectWebSocket().then(resolve).catch(reject), 1000);
        } else {
          reject(new Error(`Failed WebSocket after ${maxRetries} attempts`));
        }
      });

      const handleClose = (code, reason) => {
        logger.info(`WebSocket closed for ${channelId} (code=${code}, reason=${reason ? reason.toString() : 'none'})`);
        channelData.wsClosed = true;
        channelData.ws = null;
        sipMap.set(channelId, channelData);
        ws.off('close', handleClose);
        const cleanupResolve = cleanupPromises.get(`ws_${channelId}`);
        if (cleanupResolve) {
          cleanupResolve();
          cleanupPromises.delete(`ws_${channelId}`);
        }
      };
      ws.on('close', handleClose);
    });
  };

  setInterval(async () => {
    if (messageQueue.length > 0) {
      logGemini(`Processing message queue (size: ${messageQueue.length})`, 'debug');
      const maxMessages = 5;
      for (let i = 0; i < maxMessages && messageQueue.length > 0; i++) {
        await processMessage(messageQueue.shift());
      }
    }
  }, 10);

  try {
    await connectWebSocket();
  } catch (e) {
    logger.error(`Failed to start WebSocket for ${channelId}: ${e.message}`);
    throw e;
  }
}

export { startGeminiWebSocket };
