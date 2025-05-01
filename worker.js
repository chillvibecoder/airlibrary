import { GoogleAuth } from 'google-auth-library';
import { google } from 'googleapis';
import { vision_v1 } from '@google-cloud/vision';
import { GoogleGenerativeAI } from '@google/generative-ai';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Initialize Google clients
    const auth = new GoogleAuth({
      credentials: JSON.parse(env.GOOGLE_CREDENTIALS),
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file']
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });
    const vision = new vision_v1.ImageAnnotatorClient();
    const genAI = new GoogleGenerativeAI(env.GOOGLE_AI_API_KEY);

    // Handle different endpoints
    if (url.pathname === '/api/append') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }
      
      const data = await request.json();
      return handleAppendToSheet(sheets, data);
    }
    
    if (url.pathname === '/api/upload') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }
      
      const formData = await request.formData();
      return handleUploadToDrive(drive, formData);
    }

    return new Response('API endpoints:\n- POST /api/append\n- POST /api/upload', {
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}; 