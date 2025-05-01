// Baileys Auth Adapter for Firestore
const FirestoreAuthStateHandler = require('./auth-state-handler');

/**
 * Creates a persistent auth state for Baileys using Firestore
 */
const useFirestoreAuthState = async (credentialsJson) => {
  // Initialize the Firestore handler
  const authHandler = new FirestoreAuthStateHandler(credentialsJson);
  
  // Read the current auth state from Firestore
  let creds = await authHandler.readData();
  
  if (!creds) {
    // Create empty creds if none exist
    creds = {
      creds: {
        noiseKey: { private: Buffer.from([]), public: Buffer.from([]) },
        signedIdentityKey: { private: Buffer.from([]), public: Buffer.from([]) },
        signedPreKey: { keyPair: { private: Buffer.from([]), public: Buffer.from([]) }, signature: Buffer.from([]), keyId: 1 },
        registrationId: 0,
        advSecretKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAz78=',
        me: { id: '0@s.whatsapp.net', name: 'AirLibrary Bot' },
        account: { details: 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=', accountSignatureKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', accountSignature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', deviceSignature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
        signalIdentities: [{ identifier: { name: '0:0@s.whatsapp.net', deviceId: 0 }, identifierKey: Buffer.from([]) }],
        myAppStateKeyId: '',
        firstUnuploadedPreKeyId: 1,
        nextPreKeyId: 1,
      },
      keys: {}
    };
  }

  const saveCreds = async () => {
    // Debug check if keys are valid before saving
    const privateKeyLength = creds.creds?.noiseKey?.private?.length || 0;
    if (privateKeyLength === 0) {
      console.warn('Warning: Attempting to save auth state with empty private key');
    }
    return await authHandler.writeData(creds);
  };

  return {
    state: creds,
    saveCreds
  };
};

module.exports = { useFirestoreAuthState }; 