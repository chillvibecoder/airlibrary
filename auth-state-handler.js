const { Firestore } = require('@google-cloud/firestore');
const pino = require('pino');
const logger = pino({ level: 'info' });

class FirestoreAuthStateHandler {
  constructor(credentials) {
    try {
      this.db = new Firestore({
        credentials: typeof credentials === 'string' 
          ? JSON.parse(Buffer.from(credentials, 'base64').toString('utf-8'))
          : credentials
      });
      logger.info('Firestore auth state handler initialized');
    } catch (error) {
      logger.error('Failed to initialize Firestore:', error);
      throw error;
    }
  }

  // Write authentication state to Firestore
  async writeData(data, key = 'whatsappAuth') {
    try {
      // Convert Buffer objects to base64 strings for storage
      const processedData = this._processDataForStorage(data);
      
      // Log key lengths to debug
      if (processedData.creds?.noiseKey) {
        logger.info(`Writing authState with noiseKey length: ${
          data.creds.noiseKey.private ? data.creds.noiseKey.private.length : 0
        }`);
      }

      await this.db.collection('botState').doc(key).set(processedData);
      logger.info(`Auth state saved to Firestore: ${key}`);
      return true;
    } catch (error) {
      logger.error(`Failed to write auth state to Firestore:`, error);
      return false;
    }
  }

  // Read authentication state from Firestore
  async readData(key = 'whatsappAuth') {
    try {
      const doc = await this.db.collection('botState').doc(key).get();
      
      if (!doc.exists) {
        logger.info(`No auth state found in Firestore for key: ${key}`);
        return null;
      }
      
      // Convert base64 strings back to Buffer objects
      const data = this._processDataForRetrieval(doc.data());
      
      // Log key lengths to debug
      if (data.creds?.noiseKey) {
        logger.info(`Loaded authState with noiseKey length: ${
          data.creds.noiseKey.private ? data.creds.noiseKey.private.length : 0
        }`);
      }
      
      logger.info(`Auth state loaded from Firestore: ${key}`);
      return data;
    } catch (error) {
      logger.error(`Failed to read auth state from Firestore:`, error);
      return null;
    }
  }

  // Process data for storage in Firestore (convert Buffers to base64)
  _processDataForStorage(data) {
    if (!data) return data;

    const processValue = (value) => {
      if (Buffer.isBuffer(value)) {
        return {
          type: 'Buffer',
          data: value.toString('base64')
        };
      } else if (value !== null && typeof value === 'object') {
        return this._processDataForStorage(value);
      }
      return value;
    };

    if (Array.isArray(data)) {
      return data.map(item => processValue(item));
    }

    const result = {};
    for (const key in data) {
      result[key] = processValue(data[key]);
    }
    return result;
  }

  // Process data from Firestore for use (convert base64 to Buffers)
  _processDataForRetrieval(data) {
    if (!data) return data;

    const processValue = (value) => {
      if (value && value.type === 'Buffer' && value.data) {
        return Buffer.from(value.data, 'base64');
      } else if (value !== null && typeof value === 'object') {
        return this._processDataForRetrieval(value);
      }
      return value;
    };

    if (Array.isArray(data)) {
      return data.map(item => processValue(item));
    }

    const result = {};
    for (const key in data) {
      result[key] = processValue(data[key]);
    }
    return result;
  }

  // Delete authentication state from Firestore
  async removeData(key = 'whatsappAuth') {
    try {
      await this.db.collection('botState').doc(key).delete();
      logger.info(`Auth state deleted from Firestore: ${key}`);
      return true;
    } catch (error) {
      logger.error(`Failed to delete auth state from Firestore:`, error);
      return false;
    }
  }
}

module.exports = FirestoreAuthStateHandler; 