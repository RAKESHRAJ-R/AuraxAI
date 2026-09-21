import { config } from 'dotenv';
config();

import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

async function setHeaders() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  if (!spreadsheetId) {
    console.error('Missing GOOGLE_SHEETS_ID');
    return;
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    await sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId,
      range: 'Sheet1!A1:D1',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [
          ['Date & Time', 'Phone Number', 'Customer Name', 'Initial Message']
        ]
      },
    });

    console.log('✅ Headers successfully set at A1:D1');
  } catch (err) {
    console.error('❌ Failed to set headers:', err);
  }
}

setHeaders();
