import { initializeAriClient } from './asterisk.js';
import { logger } from './config.js';

async function startApplication() {
  try {
    logger.info('Starting application');
    await initializeAriClient();
    logger.info('Application started successfully');
  } catch (e) {
    logger.error(`Startup error: ${e.message}`);
    process.exit(1);
  }
}

startApplication();
