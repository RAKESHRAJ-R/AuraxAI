import https from 'https';

class DuckChatService {
  constructor() {
    this.endpoint = 'text.pollinations.ai';
  }

  /**
   * Query the keyless Pollinations AI API (enforcing JSON Mode) with built-in model cycling on failure
   */
  async query(messages, modelIndex = 0) {
    const models = ['openai', 'mistral', 'llama'];
    if (modelIndex >= models.length) {
      throw new Error('All Pollinations AI models failed or rate limited.');
    }

    const selectedModel = models[modelIndex];

    const postData = JSON.stringify({
      messages: messages,
      jsonMode: true,
      model: selectedModel
    });

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.endpoint,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 15000 // 15 seconds
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if ((res.statusCode === 429 || res.statusCode !== 200) && modelIndex < models.length - 1) {
            setTimeout(() => {
              this.query(messages, modelIndex + 1).then(resolve).catch(reject);
            }, 1500);
            return;
          }

          if (res.statusCode !== 200) {
            reject(new Error(`Pollinations API returned status code ${res.statusCode}: ${data}`));
            return;
          }

          try {
            const parsed = JSON.parse(data.trim());
            resolve(parsed);
          } catch (err) {
            reject(new Error(`Failed to parse response as JSON: ${err.message}`));
          }
        });
      });

      req.on('error', (e) => {
        if (modelIndex < models.length - 1) {
          setTimeout(() => {
            this.query(messages, modelIndex + 1).then(resolve).catch(reject);
          }, 1500);
        } else {
          reject(e);
        }
      });

      req.on('timeout', () => {
        req.destroy();
        if (modelIndex < models.length - 1) {
          setTimeout(() => {
            this.query(messages, modelIndex + 1).then(resolve).catch(reject);
          }, 1500);
        } else {
          reject(new Error('Request timed out after 15 seconds'));
        }
      });

      req.write(postData);
      req.end();
    });
  }
}

const duckChatService = new DuckChatService();
export default duckChatService;
