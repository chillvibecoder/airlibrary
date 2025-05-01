// Baileys Auth Adapter for Firestore
const FirestoreAuthStateHandler = require('./auth-state-handler');
const { initAuthCreds } = require('@whiskeysockets/baileys');

/**
 * Creates a persistent auth state for Baileys using Firestore
 */
const useFirestoreAuthState = async (credentialsJson, forceReset = false) => {
  // Initialize the Firestore handler
  const authHandler = new FirestoreAuthStateHandler(credentialsJson);
  
  // Delete existing auth state if force reset is enabled
  if (forceReset) {
    console.log('Forcing new auth session - deleting existing auth state...');
    await authHandler.removeData();
  }

  // Read the current auth state from Firestore
  let creds = await authHandler.readData();
  
  if (!creds || !creds.creds || 
      !creds.creds.noiseKey || 
      !creds.creds.noiseKey.private || 
      creds.creds.noiseKey.private.length === 0) {
    console.log('No valid auth state found - creating new session');
    
    // Initialize with Baileys default credentials
    creds = {
      creds: initAuthCreds(),
      keys: {}
    };
  } else {
    console.log('Using existing auth state with noiseKey length:', 
      creds.creds.noiseKey.private ? creds.creds.noiseKey.private.length : 0);
  }

  const saveCreds = async () => {
    // Debug check if keys are valid before saving
    const privateKeyLength = creds.creds?.noiseKey?.private?.length || 0;
    if (privateKeyLength === 0) {
      console.warn('Warning: Attempting to save auth state with empty private key');
    } else {
      console.log('Saving auth state with noiseKey length:', privateKeyLength);
    }
    return await authHandler.writeData(creds);
  };

  return {
    state: creds,
    saveCreds
  };
};

module.exports = { useFirestoreAuthState }; 