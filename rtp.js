import dgram from 'dgram';
import { EventEmitter } from 'events';
import { config, logger } from './config.js';
import { sipMap, rtpSenders, rtpReceivers } from './state.js';

logger.info('Loading rtp.js module');

// Convert g711 μ-law to 16-bit PCM
function ulawToPCM(ulawBuffer) {
  const pcmBuffer = Buffer.alloc(ulawBuffer.length * 2);
  const BIAS = 0x84;

  for (let i = 0; i < ulawBuffer.length; i++) {
    const ulaw = ulawBuffer[i] ^ 0xFF;
    const sign = (ulaw & 0x80) ? -1 : 1;
    const exponent = (ulaw >> 4) & 0x07;
    const mantissa = ulaw & 0x0F;

    let decoded = ((mantissa << 3) + BIAS) << exponent;
    decoded -= BIAS;
    decoded = sign * decoded;

    if (decoded > 32767) decoded = 32767;
    if (decoded < -32768) decoded = -32768;

    pcmBuffer.writeInt16LE(decoded, i * 2);
  }

  return pcmBuffer;
}

const usedRtpPorts = new Set();
const rtpEvents = new EventEmitter();

function getNextRtpPort() {
  let port = config.RTP_PORT_START;
  while (usedRtpPorts.has(port)) port += 2;
  if (usedRtpPorts.size >= config.MAX_CONCURRENT_CALLS) {
    logger.warn('Maximum concurrent calls reached, reusing oldest port');
    const oldestPort = Math.min(...usedRtpPorts);
    usedRtpPorts.delete(oldestPort);
    return oldestPort;
  }
  usedRtpPorts.add(port);
  return port;
}

function releaseRtpPort(port) {
  usedRtpPorts.delete(port);
}

const rtpStats = new Map();

function recordRtpLog(channelId, shortMsg) {
  const stats = rtpStats.get(channelId) || { count: 0, lastLogged: 0 };
  stats.count += 1;
  const now = Date.now();
  if (process.env.DEBUG_RTP === 'true') {
    logger.info(`${shortMsg} (packet#${stats.count})`);
  } else if (stats.count % 30 === 0 || now - stats.lastLogged > 3000) {
    logger.info(`${shortMsg} (summarized after ${stats.count} packets)`);
    stats.lastLogged = now;
    stats.count = 0;
  }
  rtpStats.set(channelId, stats);
}

function startRTPReceiver(channelId, port) {
  const rtpReceiver = dgram.createSocket('udp4');
  rtpReceiver.isOpen = true;
  rtpReceivers.set(channelId, rtpReceiver);

  rtpReceiver.on('listening', () => logger.info(`RTP Receiver for ${channelId} listening on 127.0.0.1:${port}`));
  rtpReceiver.on('message', (msg, rinfo) => {
    recordRtpLog(channelId, `RTP packet received ${msg.length} bytes from ${rinfo.address}:${rinfo.port}`);
    const channelData = sipMap.get(channelId);
    if (!channelData) {
      logger.warn(`No channelData for ${channelId} when receiving RTP message`);
      return;
    }
    if (!channelData.rtpSource) {
      channelData.rtpSource = { address: rinfo.address, port: rinfo.port };
      sipMap.set(channelId, channelData);
      logger.info(`RTP source assigned for ${channelId}: ${rinfo.address}:${rinfo.port}`);
    }
    if (!channelData.ws) {
      logger.warn(`WebSocket not initialized for ${channelId}`);
      return;
    }
    logger.debug(`WebSocket state for ${channelId}: ${channelData.ws.readyState} (1=OPEN, 2=CLOSING, 3=CLOSED)`);

    // 自動VADを利用するので手動の activityStart/activityEnd は不要
    // ただし必要ならコメントアウトして再度有効化可能

    if (channelData.ws.readyState === 1) {
      const audioData = msg.slice(12);
      logger.debug(`Extracted audio data: ${audioData.length} bytes`);
      const pcmData8k = ulawToPCM(audioData);

      // Upsample 8kHz to 16kHz for Gemini
      const pcmData16k = Buffer.alloc(pcmData8k.length * 2);
      for (let i = 0; i < pcmData8k.length / 2; i++) {
        const sample = pcmData8k.readInt16LE(i * 2);
        pcmData16k.writeInt16LE(sample, i * 4);
        pcmData16k.writeInt16LE(sample, i * 4 + 2);
      }

      logger.debug(`Converted to 16kHz PCM: ${pcmData16k.length} bytes`);
      try {
        channelData.ws.send(JSON.stringify({
          realtimeInput: {
            mediaChunks: [{
              mimeType: "audio/pcm;rate=16000", // Gemini音声入力は16KHz
              data: pcmData16k.toString('base64')
            }]
          }
        }));
        logger.debug(`Audio sent successfully to Gemini for ${channelId}`);
      } catch (err) {
        logger.error(`Error sending audio to Gemini for ${channelId}: ${err.message}`);
      }
    } else {
      logger.warn(`WebSocket not ready for ${channelId} (state=${channelData.ws.readyState})`);
    }

    sipMap.set(channelId, channelData);
  });
  rtpReceiver.on('error', (err) => logger.error(`RTP Receiver error for ${channelId}: ${err.message}`));
  rtpReceiver.bind(port, '127.0.0.1');
}

function buildRTPHeader(seq, timestamp, ssrc) {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = 0x00;
  header.writeUInt16BE(seq, 2);
  header.writeUInt32BE(timestamp, 4);
  header.writeUInt32BE(ssrc, 8);
  return header;
}

async function streamAudio(channelId, rtpSource) {
  logger.info(`Initializing RTP stream to ${rtpSource.address}:${rtpSource.port} for ${channelId}`);
  let audioBuffer = Buffer.alloc(0);
  let rtpSequence = Math.floor(Math.random() * 65535);
  let rtpTimestamp = 0;
  const rtpSsrc = Math.floor(Math.random() * 4294967295);
  let totalPacketsSent = 0;
  const maxBufferSize = 640;
  const samplesPerPacket = 160;
  let lastBufferWarnTime = 0;
  let totalBytesSent = 0;
  let isSocketClosed = false;
  const ptimeStats = { count: 0, sum: 0, min: Infinity, max: -Infinity, lastTime: null };
  let packetsPerSecond = 0;
  let lastSecond = Date.now();
  let packetQueue = [];
  let intervalId = null;

  const rtpSender = dgram.createSocket('udp4');
  rtpSender.isOpen = true;
  rtpSenders.set(channelId, rtpSender);

  function writeAudio(data) {
    if (data.length === 0 || data.every(byte => byte === 0x7F)) {
      logger.warn(`Received empty or silent audio for ${channelId}`);
      return false;
    }
    const freeSpace = maxBufferSize - audioBuffer.length;
    if (data.length > freeSpace) {
      const now = Date.now();
      if (now - lastBufferWarnTime >= 1000) {
        logger.warn(`Buffer full for ${channelId}, discarding ${data.length - freeSpace} bytes`);
        lastBufferWarnTime = now;
      }
      return false;
    }
    audioBuffer = Buffer.concat([audioBuffer, data]);
    return true;
  }

  function sendRtpPacket(packetBuffer) {
    if (!sipMap.has(channelId) || isSocketClosed) {
      logger.info(`Cannot send RTP packet for ${channelId}: channel gone or socket closed`);
      return;
    }
    let offset = 0;
    while (offset < packetBuffer.length) {
      let packetData = packetBuffer.slice(offset, Math.min(offset + samplesPerPacket, packetBuffer.length));
      offset += samplesPerPacket;
      if (packetData.length < samplesPerPacket) {
        packetData = Buffer.concat([packetData, Buffer.alloc(samplesPerPacket - packetData.length, 0x7F)]);
      }
      packetQueue.push({ data: packetData, seq: rtpSequence, timestamp: rtpTimestamp });
      rtpSequence = (rtpSequence + 1) % 65536;
      rtpTimestamp += samplesPerPacket;
    }
    if (!intervalId) {
      processPacketQueue();
    }
  }

  function stopPlayback() {
    if (intervalId) {
      clearTimeout(intervalId);
      intervalId = null;
    }
    packetQueue = [];
    logger.info(`Playback stopped for ${channelId}`);
  }

  function processPacketQueue() {
    if (intervalId) {
      return;
    }

    let isFirstPacketAfterResume = true;
    let nextPacketTime = Date.now() + 20;

    const tick = () => {
      if (packetQueue.length === 0) {
        intervalId = null;
        logger.info(`Finished sending delta buffer for ${channelId}, total packets: ${totalPacketsSent}, queue size: ${packetQueue.length}`);
        rtpEvents.emit('audioFinished', channelId);
        return;
      }

      if (!sipMap.has(channelId) || isSocketClosed) {
        logger.info(`Channel ${channelId} gone or socket closed, emitting audioFinished, queue size: ${packetQueue.length}`);
        intervalId = null;
        rtpEvents.emit('audioFinished', channelId);
        return;
      }

      const packet = packetQueue.shift();
      const startTime = Date.now();
      const header = buildRTPHeader(packet.seq, packet.timestamp, rtpSsrc);
      const rtpPacket = Buffer.concat([header, packet.data]);
      const channelData = sipMap.get(channelId) || {};
      const sendPort = channelData.rtpSource ? channelData.rtpSource.port : rtpSource.port;
      const sendAddress = channelData.rtpSource ? channelData.rtpSource.address : rtpSource.address;

      rtpSender.send(rtpPacket, sendPort, sendAddress, (err) => {
        if (err) {
          logger.error(`Error sending RTP packet for ${channelId} to ${sendAddress}:${sendPort}: ${err.message}`);
        } else {
          totalPacketsSent++;
          totalBytesSent += samplesPerPacket;
          packetsPerSecond++;
          const packetTime = Date.now();
          if (packetTime - lastSecond >= 10000) {
            logger.info(`Packets per second for ${channelId}: ${(packetsPerSecond / 10).toFixed(2)}`);
            packetsPerSecond = 0;
            lastSecond = packetTime;
          }
          if (ptimeStats.lastTime && !isFirstPacketAfterResume) {
            const interval = packetTime - ptimeStats.lastTime;
            if (interval >= 10 && interval <= 60) {
              ptimeStats.count++;
              ptimeStats.sum += interval;
              ptimeStats.min = Math.min(ptimeStats.min, interval);
              ptimeStats.max = Math.min(ptimeStats.max, interval);
            } else if (interval > 60) {
              logger.warn(`Critical ptime deviation: ${interval.toFixed(2)}ms for packet ${totalPacketsSent}, buffer size: ${audioBuffer.length} bytes for ${channelId}`);
            }
          }
          ptimeStats.lastTime = packetTime;
          isFirstPacketAfterResume = false;
        }
      });

      const processingTime = Date.now() - startTime;
      if (processingTime > 5) {
        logger.warn(`High processing time for packet ${totalPacketsSent}: ${processingTime}ms`);
      }

      const now = Date.now();
      nextPacketTime += 20;
      if (now > nextPacketTime + 100) {
        // We are too far behind, reset the clock to avoid sending a burst
        nextPacketTime = now + 20;
      }
      let delay = nextPacketTime - now;
      if (delay < 0) delay = 0;
      intervalId = setTimeout(tick, delay);
    };

    intervalId = setTimeout(tick, 20);
  }

  function endStream() {
    const avgPtime = ptimeStats.count > 0 ? (ptimeStats.sum / ptimeStats.count).toFixed(2) : 'N/A';
    logger.info(`RTP stream ended for ${channelId}, total packets sent: ${totalPacketsSent}, total bytes: ${totalBytesSent}, final buffer: ${audioBuffer.length} bytes, avg ptime: ${avgPtime}ms`);
    if (intervalId) {
      clearTimeout(intervalId);
      intervalId = null;
    }
    if (!isSocketClosed) {
      isSocketClosed = true;
      rtpSender.isOpen = false;
      rtpSender.close();
    }
  }

  return {
    write: writeAudio,
    end: endStream,
    sendRtpPacket: sendRtpPacket,
    stopPlayback: stopPlayback,
    audioBuffer,
    packetQueue
  };
}

export { startRTPReceiver, getNextRtpPort, releaseRtpPort, streamAudio, rtpEvents };
