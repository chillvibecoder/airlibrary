// Baileys Auth Adapter for Firestore
const FirestoreAuthStateHandler = require('./auth-state-handler');
const { proto } = require('@whiskeysockets/baileys');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

// Manual auth token for direct usage (from QR code scan)
const manualAuthToken = `2@wAX4i2ldfVehoQyMwOKvwsDBam3TmenhbRhOzUbuaL3rILL20ksbHjImwL+YK3meKKFnEN/qKfwsor4WesH3xPhuKozEBSdNF4w=,QNEcDj7e4OvWgVCr+Cn2q37hFMXoDwra9sl6eWecCXA=,2wxp0lwTPTLFVAplc2ptMBqnny0VbtJqkKIMh3TL7Ug=,G7xQ6H0MzyxdwDluUwkowkHtTZ3GHxsVk4ckL37yzyo=`;

/**
 * Creates a persistent auth state for Baileys using Firestore
 */
const useFirestoreAuthState = async (credentialsJson, forceReset = false, useManualToken = true) => {
  // Initialize the Firestore handler
  const authHandler = new FirestoreAuthStateHandler(credentialsJson);
  
  // Delete existing auth state if force reset is enabled
  if (forceReset) {
    console.log('Forcing new auth session - deleting existing auth state...');
    await authHandler.removeData();
  }

  // Read the current auth state from Firestore
  let creds = await authHandler.readData();
  
  if ((!creds || !creds.creds || 
      !creds.creds.noiseKey || 
      !creds.creds.noiseKey.private || 
      creds.creds.noiseKey.private.length === 0) &&
      useManualToken && manualAuthToken) {
    
    console.log('No valid auth state found - using manual token');
    
    // Parse the token (format: n@token,noise,ident,sign)
    const [fullPrefix, tokens] = manualAuthToken.split('@');
    const [token, noiseKey, identityKey, signedPreKey] = tokens.split(',');
    
    // Create new creds using the token
    const baseCreds = initAuthCreds();
    
    // Build a fully structured creds object
    creds = {
      creds: {
        ...baseCreds,
        me: { 
          id: fullPrefix + '@s.whatsapp.net', 
          name: 'AirLibrary Bot',
          verifiedName: 'AirLibrary Bot'
        },
        noiseKey: { 
          private: Buffer.from(noiseKey, 'base64'),
          public: Buffer.from(noiseKey, 'base64')
        },
        signedIdentityKey: {
          private: Buffer.from(identityKey, 'base64'),
          public: Buffer.from(identityKey, 'base64')
        },
        signedPreKey: {
          keyPair: {
            private: Buffer.from(signedPreKey, 'base64'),
            public: Buffer.from(signedPreKey, 'base64')
          },
          signature: Buffer.from([]),
          keyId: 1
        },
        registrationId: parseInt(fullPrefix),
        // Additional fields to ensure full compatibility
        advSecretKey: baseCreds.advSecretKey,
        nextPreKeyId: baseCreds.nextPreKeyId,
        firstUnuploadedPreKeyId: baseCreds.firstUnuploadedPreKeyId,
        serverHasPreKeys: false
      },
      keys: {
        // Include some pre-keys to avoid precondition errors
        'preKeys': {
          '1': {
            keyPair: {
              private: Buffer.from(noiseKey, 'base64'),
              public: Buffer.from(noiseKey, 'base64')
            },
            keyId: 1
          }
        }
      }
    };
  } else if (!creds || !creds.creds || 
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