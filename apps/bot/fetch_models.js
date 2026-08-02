import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './src/config/config.js';

const fetchModels = async () => {
  try {
    const groqKey = process.env.GROQ_API_KEY || config.groq?.apiKey || config.openai?.apiKey;
    console.log("Using API Key:", groqKey ? "Found" : "Not Found");
    const response = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${groqKey}` }
    });
    const data = await response.json();
    if (data.data) {
      console.log(data.data.map(m => m.id));
    } else {
      console.error(data);
    }
  } catch (err) {
    console.error(err);
  }
};

fetchModels();
