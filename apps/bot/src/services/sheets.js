import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CREDENTIALS_PATH = path.join(__dirname, '../../credentials.json');

class SheetsService {
  constructor() {
    this.auth = new google.auth.GoogleAuth({
      keyFile: CREDENTIALS_PATH,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  async appendRow(data) {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
    if (!spreadsheetId) {
      console.warn('[SheetsService] Missing GOOGLE_SHEETS_ID in environment variables.');
      return;
    }

    try {
      const client = await this.auth.getClient();
      const sheets = google.sheets({ version: 'v4', auth: client });

      const response = await sheets.spreadsheets.values.append({
        spreadsheetId: spreadsheetId,
        range: 'Sheet1!A:E',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [data],
        },
      });
      console.log('[SheetsService] Appended row to Google Sheets:', response.data.updates.updatedRange);
    } catch (error) {
      console.error('[SheetsService] Error appending to Google Sheets:', error.message);
    }
  }
}

const sheetsService = new SheetsService();
export default sheetsService;
