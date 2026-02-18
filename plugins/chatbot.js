const { cmd } = require('../sila');
const { getUserConfigFromMongoDB, updateUserConfigInMongoDB } = require('../lib/database');

// ============================================
// CHATBOT COMMAND - Toggle AI Chatbot
// ============================================
cmd({
  pattern: "chatbot",
  alias: ["silabot", "aibot", "setchatbot"],
  react: "🤖",
  category: "ai",
  desc: "Turn AI chatbot ON/OFF for your number",
  filename: __filename
}, async (conn, mek, m, { from, q, reply, senderNumber }) => {
  try {
    
    // Get current user config from database
    const userConfig = await getUserConfigFromMongoDB(senderNumber);
    
    // If no argument, show current status
    if (!q) {
      const currentStatus = userConfig.CHATBOT_ENABLED === 'true' ? '✅ ON' : '❌ OFF';
      
      const statusMessage = `*🤖 AI CHATBOT*\n\n` +
        `📱 *Number:* ${senderNumber}\n` +
        `⚙️ *Current Status:* ${currentStatus}\n\n` +
        `*Commands:*\n` +
        `• *.chatbot on* - Turn ON AI chatbot\n` +
        `• *.chatbot off* - Turn OFF AI chatbot\n\n` +
        `*How it works:*\n` +
        `When ON, the bot will automatically reply to all your messages without prefix using AI.`;
      
      return reply(statusMessage);
    }
    
    // Process ON/OFF command
    const option = q.toLowerCase().trim();
    
    if (option === 'on' || option === 'enable') {
      
      // Update config to ON
      userConfig.CHATBOT_ENABLED = 'true';
      await updateUserConfigInMongoDB(senderNumber, userConfig);
      
      const successMessage = `*✅ CHATBOT ENABLED*\n\n` +
        `AI chatbot is now *ON* for your number.\n` +
        `I will automatically reply to all your messages without prefix.`;
      
      await reply(successMessage);
      
      // Send example
      await conn.sendMessage(from, {
        text: `*Example:*\nJust send any message like "Hello" or "How are you?" and I'll reply with AI.`,
        footer: '© SILA MD'
      }, { quoted: mek });
      
    } else if (option === 'off' || option === 'disable') {
      
      // Update config to OFF
      userConfig.CHATBOT_ENABLED = 'false';
      await updateUserConfigInMongoDB(senderNumber, userConfig);
      
      const successMessage = `*❌ CHATBOT DISABLED*\n\n` +
        `AI chatbot is now *OFF* for your number.\n` +
        `I will only reply to commands with prefix (${config.PREFIX || '.'}).`;
      
      await reply(successMessage);
      
    } else {
      reply("❌ Invalid option! Use: *.chatbot on* or *.chatbot off*");
    }
    
  } catch (err) {
    console.log("CHATBOT COMMAND ERROR:", err.message);
    reply("❌ Chatbot command error");
  }
});

// ============================================
// AUTO-RESPONSE FOR NON-COMMAND MESSAGES
// (This part is already in silamd.js main file)
// ============================================
/*
The actual AI response for non-command messages is handled in silamd.js:
------------------------------------------------
if (!isCmd && userConfig.CHATBOT_ENABLED === 'true' && body.trim()) {
    const aiResponse = await chatbot(conn, m, body);
    if (aiResponse) {
        await m.reply(aiResponse);
    }
}
------------------------------------------------
*/
