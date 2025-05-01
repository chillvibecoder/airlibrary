require('dotenv').config();
const { Firestore } = require('@google-cloud/firestore');
const FirestoreAuthStateHandler = require('./auth-state-handler');

// WhatsApp auth token from Render logs
const authToken = `2@wAX4i2ldfVehoQyMwOKvwsDBam3TmenhbRhOzUbuaL3rILL20ksbHjImwL+YK3meKKFnEN/qKfwsor4WesH3xPhuKozEBSdNF4w=,QNEcDj7e4OvWgVCr+Cn2q37hFMXoDwra9sl6eWecCXA=,2wxp0lwTPTLFVAplc2ptMBqnny0VbtJqkKIMh3TL7Ug=,G7xQ6H0MzyxdwDluUwkowkHtTZ3GHxsVk4ckL37yzyo=`;

async function setWhatsAppAuth() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    console.error('GOOGLE_SERVICE_ACCOUNT environment variable is required');
    process.exit(1);
  }

  try {
    // Initialize Firestore auth handler
    const authHandler = new FirestoreAuthStateHandler(process.env.GOOGLE_SERVICE_ACCOUNT);
    console.log('Firestore auth handler initialized');

    // Get the existing auth state
    let state = await authHandler.readData();
    if (!state) {
      console.log('No existing auth state found, creating new state');
      state = {
        creds: {
          noiseKey: { private: Buffer.from([]), public: Buffer.from([]) },
          signedIdentityKey: { private: Buffer.from([]), public: Buffer.from([]) },
          signedPreKey: { keyPair: { private: Buffer.from([]), public: Buffer.from([]) }, signature: Buffer.from([]), keyId: 1 },
          registrationId: 0,
          advSecretKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAz78=',
          me: { id: '0@s.whatsapp.net', name: 'AirLibrary Bot' },
          myAppStateKeyId: '',
          firstUnuploadedPreKeyId: 1,
          nextPreKeyId: 1,
        },
        keys: {}
      };
    }

    // Set the auth token
    console.log('Setting auth token');
    
    // Parse the token (format: 1@token,noise,ident,sign)
    const [fullPrefix, tokens] = authToken.split('@');
    const [token, noiseKey, identityKey, signedPreKey] = tokens.split(',');
    
    // Decode base64 components
    console.log('Decoding auth token components');
    
    // Update the auth state with the token components
    state.creds.me = { id: authToken.split('@')[0] + '@s.whatsapp.net', name: 'AirLibrary Bot' };
    state.creds.noiseKey = { 
      private: Buffer.from(noiseKey, 'base64'),
      public: Buffer.from(noiseKey, 'base64')  // Placeholder, will be regenerated
    };
    state.creds.signedIdentityKey = {
      private: Buffer.from(identityKey, 'base64'),
      public: Buffer.from(identityKey, 'base64')  // Placeholder, will be regenerated
    };
    state.creds.signedPreKey = {
      keyPair: {
        private: Buffer.from(signedPreKey, 'base64'),
        public: Buffer.from(signedPreKey, 'base64')  // Placeholder, will be regenerated
      },
      signature: Buffer.from([]),
      keyId: 1
    };
    state.creds.registrationId = parseInt(fullPrefix);
    
    // Save the updated auth state to Firestore
    console.log('Saving auth state to Firestore');
    const result = await authHandler.writeData(state);
    
    if (result) {
      console.log('Auth state successfully saved to Firestore');
    } else {
      console.error('Failed to save auth state to Firestore');
    }
  } catch (error) {
    console.error('Error setting WhatsApp auth:', error);
  }
}

setWhatsAppAuth().catch(console.error); 