import { config } from 'dotenv';
config();

import sheetsService from './src/services/sheets.js';

async function runTest() {
  console.log('Testing Google Sheets connection...');
  try {
    await sheetsService.appendRow([
      new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      '1234567890',
      'Test User',
      'This is a test message from the bot.'
    ]);
    console.log('✅ Test complete. Check the Google Sheet!');
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

runTest();
