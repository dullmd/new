const { cmd } = require('../sila');
const config = require('../config');

// ============================================
// CHANNEL COMMAND
// ============================================
cmd({
  pattern: "channel",
  alias: ["chan", "ch", "myChannel"],
  react: "📢",
  category: "main",
  desc: "Get SILA MD channel link",
  filename: __filename
}, async (conn, mek, m, { from, reply, isOwner }) => {
  try {
    
    const channelLink = config.WELCOME_CHANNEL || 'https://whatsapp.com/channel/0029VbBG4gfISTkCpKxyMH02';
    
    // Send channel info with REPO button
    await conn.sendMessage(from, {
      text: `*📢 SILA MD CHANNEL*\n\nJoin our official channel for latest updates, news, and features!\n\n🔗 *Link:* ${channelLink}`,
      footer: config.BOT_FOOTER || '© SILA MD',
      buttons: [
        {
          buttonId: `.repo`,  // This will trigger the repo command when clicked
          buttonText: { displayText: '💻 REPO' },
          type: 1
        }
      ],
      headerType: 1
    }, { quoted: mek });
    
  } catch (err) {
    console.log("CHANNEL COMMAND ERROR:", err.message);
    reply("❌ Channel command error");
  }
});

// ============================================
// REPO COMMAND
// ============================================
cmd({
  pattern: "repo",
  alias: ["repository", "github", "git"],
  react: "💻",
  category: "main",
  desc: "Get SILA MD repository link",
  filename: __filename
}, async (conn, mek, m, { from, reply, isOwner }) => {
  try {
    
    const repoLink = config.WELCOME_REPO || 'https://github.com/Sila-Md/SILA-MD';
    
    // Send repo info with CHANNEL button
    await conn.sendMessage(from, {
      text: `*💻 SILA MD REPOSITORY*\n\n⭐ Star the repo if you like this bot!\n🔗 *Link:* ${repoLink}\n\n💡 *Features:*\n• Multi-device support\n• 100+ plugins\n• Easy to deploy\n• Regular updates`,
      footer: config.BOT_FOOTER || '© SILA MD',
      buttons: [
        {
          buttonId: `.channel`,  // This will trigger the channel command when clicked
          buttonText: { displayText: '📢 CHANNEL' },
          type: 1
        }
      ],
      headerType: 1
    }, { quoted: mek });
    
  } catch (err) {
    console.log("REPO COMMAND ERROR:", err.message);
    reply("❌ Repo command error");
  }
});

// ============================================
// WELCOME MESSAGE WITH BUTTONS (For new connections)
// ============================================
// This part goes in silamd.js - but here's the function
async function sendWelcomeMessage(conn, jid) {
  try {
    const welcomeButtons = [
      {
        buttonId: `.channel`,
        buttonText: { displayText: '📢 CHANNEL' },
        type: 1
      },
      {
        buttonId: `.repo`,
        buttonText: { displayText: '💻 REPO' },
        type: 1
      }
    ];
    
    await conn.sendMessage(jid, {
      text: `*👑 ${config.BOT_NAME} 👑*\n\n` +
            `✅ *Bot connected successfully!*\n\n` +
            `*Click buttons below to explore:*`,
      footer: config.BOT_FOOTER,
      buttons: welcomeButtons,
      headerType: 1
    });
  } catch (error) {
    console.error('Welcome message error:', error);
  }
}

module.exports = { sendWelcomeMessage };
