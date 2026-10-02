import async from 'async';

console.log('--- SIMULATING 15 CUSTOMERS MESSAGING AT ONCE ---');

let activeConnections = 0;

// Create the exact same queue we built in your whatsapp-web-bot.js
const messageQueue = async.queue(async (task) => {
  activeConnections++;
  console.log(`[Queue] Processing Customer ${task.id}... (Currently processing: ${activeConnections}/5 | Waiting in line: ${messageQueue.length()})`);
  
  // Simulate the Groq AI taking 2 seconds to reply
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  activeConnections--;
}, 5); // CONCURRENCY LIMIT = 5

// Simulate 15 messages hitting the server at the exact same millisecond
for (let i = 1; i <= 15; i++) {
  messageQueue.push({ id: i });
}

messageQueue.drain(() => {
  console.log('--- ALL MESSAGES PROCESSED SUCCESSFULLY WITH NO CRASHES ---');
});
