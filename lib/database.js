const { Pool } = require('pg');
const config = require('../config');
const bcrypt = require('bcrypt');

const pool = new Pool({
    connectionString: config.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const connectdb = async () => {
    try {
        // Test connection
        await pool.query('SELECT NOW()');
        console.log("✅ PostgreSQL Database Connected Successfully");
        
        // Create tables if they don't exist
        await createTables();
    } catch (e) {
        console.error("❌ Database Connection Failed:", e.message);
        process.exit(1);
    }
};

const createTables = async () => {
    try {
        // Users table (for web login)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                email VARCHAR(255),
                full_name VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP
            )
        `);

        // Sessions table (for web login sessions)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_sessions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                session_token VARCHAR(255) UNIQUE NOT NULL,
                ip_address VARCHAR(45),
                user_agent TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL
            )
        `);

        // WhatsApp sessions table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS whatsapp_sessions (
                id SERIAL PRIMARY KEY,
                number VARCHAR(20) UNIQUE NOT NULL,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                credentials JSONB NOT NULL,
                is_active BOOLEAN DEFAULT true,
                bot_config JSONB DEFAULT '{}'::jsonb,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_connected TIMESTAMP
            )
        `);

        // User config table (per number settings)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_configs (
                id SERIAL PRIMARY KEY,
                number VARCHAR(20) UNIQUE NOT NULL,
                config JSONB DEFAULT '{
                    "AUTO_RECORDING": "false",
                    "AUTO_TYPING": "false",
                    "ANTI_CALL": "false",
                    "REJECT_MSG": "*🔕 ʏᴏᴜʀ ᴄᴀʟʟ ᴡᴀs ᴀᴜᴛᴏᴍᴀᴛɪᴄᴀʟʟʏ ʀᴇᴊᴇᴄᴛᴇᴅ..!*",
                    "READ_MESSAGE": "false",
                    "AUTO_VIEW_STATUS": "false",
                    "AUTO_LIKE_STATUS": "false",
                    "AUTO_STATUS_REPLY": "false",
                    "AUTO_STATUS_MSG": "Hello from SILA MD !",
                    "AUTO_LIKE_EMOJI": ["❤️", "👍", "😮", "😎"]
                }'::jsonb,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // OTP table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS otps (
                id SERIAL PRIMARY KEY,
                number VARCHAR(20) NOT NULL,
                otp VARCHAR(10) NOT NULL,
                config JSONB NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Stats table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stats (
                id SERIAL PRIMARY KEY,
                number VARCHAR(20) NOT NULL,
                date DATE NOT NULL,
                commands_used INTEGER DEFAULT 0,
                messages_received INTEGER DEFAULT 0,
                messages_sent INTEGER DEFAULT 0,
                groups_interacted INTEGER DEFAULT 0,
                UNIQUE(number, date)
            )
        `);

        console.log("✅ Database tables created/verified");
    } catch (error) {
        console.error("❌ Error creating tables:", error);
    }
};

// ====================================
// USER AUTHENTICATION FUNCTIONS
// ====================================

// Register new user
async function registerUser(username, password, email = null, fullName = null) {
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (username, password, email, full_name) VALUES ($1, $2, $3, $4) RETURNING id, username',
            [username, hashedPassword, email, fullName]
        );
        return { success: true, user: result.rows[0] };
    } catch (error) {
        if (error.code === '23505') { // Unique violation
            return { success: false, error: 'Username already exists' };
        }
        console.error('❌ Register error:', error);
        return { success: false, error: 'Registration failed' };
    }
}

// Login user
async function loginUser(username, password) {
    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE username = $1',
            [username]
        );
        
        if (result.rows.length === 0) {
            return { success: false, error: 'Invalid username or password' };
        }
        
        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
            return { success: false, error: 'Invalid username or password' };
        }
        
        // Update last login
        await pool.query(
            'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
            [user.id]
        );
        
        return { 
            success: true, 
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                full_name: user.full_name
            }
        };
    } catch (error) {
        console.error('❌ Login error:', error);
        return { success: false, error: 'Login failed' };
    }
}

// Create session token
async function createUserSession(userId, sessionToken, ipAddress, userAgent) {
    try {
        // Expires in 7 days
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);
        
        await pool.query(
            'INSERT INTO user_sessions (user_id, session_token, ip_address, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5)',
            [userId, sessionToken, ipAddress, userAgent, expiresAt]
        );
        return { success: true };
    } catch (error) {
        console.error('❌ Create session error:', error);
        return { success: false };
    }
}

// Validate session token
async function validateSessionToken(sessionToken) {
    try {
        const result = await pool.query(
            `SELECT u.* FROM users u 
             JOIN user_sessions s ON u.id = s.user_id 
             WHERE s.session_token = $1 AND s.expires_at > CURRENT_TIMESTAMP`,
            [sessionToken]
        );
        
        if (result.rows.length === 0) {
            return { valid: false };
        }
        
        return { valid: true, user: result.rows[0] };
    } catch (error) {
        console.error('❌ Validate session error:', error);
        return { valid: false };
    }
}

// Delete session (logout)
async function deleteUserSession(sessionToken) {
    try {
        await pool.query('DELETE FROM user_sessions WHERE session_token = $1', [sessionToken]);
        return { success: true };
    } catch (error) {
        console.error('❌ Delete session error:', error);
        return { success: false };
    }
}

// Get user's WhatsApp numbers
async function getUserWhatsAppNumbers(userId) {
    try {
        const result = await pool.query(
            'SELECT number, is_active, bot_config, last_connected FROM whatsapp_sessions WHERE user_id = $1',
            [userId]
        );
        return result.rows;
    } catch (error) {
        console.error('❌ Get user numbers error:', error);
        return [];
    }
}

// Save WhatsApp session with user ID
async function saveSessionToMongoDB(number, credentials, userId = null) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        
        // Check if exists
        const existing = await pool.query(
            'SELECT id FROM whatsapp_sessions WHERE number = $1',
            [cleanNumber]
        );
        
        if (existing.rows.length > 0) {
            // Update
            await pool.query(
                'UPDATE whatsapp_sessions SET credentials = $1, updated_at = CURRENT_TIMESTAMP, last_connected = CURRENT_TIMESTAMP WHERE number = $2',
                [JSON.stringify(credentials), cleanNumber]
            );
        } else {
            // Insert
            await pool.query(
                'INSERT INTO whatsapp_sessions (number, user_id, credentials, is_active, last_connected) VALUES ($1, $2, $3, true, CURRENT_TIMESTAMP)',
                [cleanNumber, userId || null, JSON.stringify(credentials)]
            );
        }
        
        console.log(`📁 Session saved to PostgreSQL for ${cleanNumber}`);
        return true;
    } catch (error) {
        console.error('❌ Error saving session to PostgreSQL:', error);
        return false;
    }
}

// Get session
async function getSessionFromMongoDB(number) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        const result = await pool.query(
            'SELECT credentials FROM whatsapp_sessions WHERE number = $1',
            [cleanNumber]
        );
        
        if (result.rows.length > 0) {
            return result.rows[0].credentials;
        }
        return null;
    } catch (error) {
        console.error('❌ Error getting session from PostgreSQL:', error);
        return null;
    }
}

// Delete session
async function deleteSessionFromMongoDB(number) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        await pool.query('DELETE FROM whatsapp_sessions WHERE number = $1', [cleanNumber]);
        console.log(`🗑️ Session deleted from PostgreSQL for ${cleanNumber}`);
        return true;
    } catch (error) {
        console.error('❌ Error deleting session from PostgreSQL:', error);
        return false;
    }
}

// Get user config
async function getUserConfigFromMongoDB(number) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        const result = await pool.query(
            'SELECT config FROM user_configs WHERE number = $1',
            [cleanNumber]
        );
        
        if (result.rows.length > 0) {
            return result.rows[0].config;
        } else {
            // Default config
            const defaultConfig = {
                AUTO_RECORDING: 'false',
                AUTO_TYPING: 'false',
                ANTI_CALL: 'false',
                REJECT_MSG: '*🔕 ʏᴏᴜʀ ᴄᴀʟʟ ᴡᴀs ᴀᴜᴛᴏᴍᴀᴛɪᴄᴀʟʟʏ ʀᴇᴊᴇᴄᴛᴇᴅ..!*',
                READ_MESSAGE: 'false',
                AUTO_VIEW_STATUS: 'false',
                AUTO_LIKE_STATUS: 'false',
                AUTO_STATUS_REPLY: 'false',
                AUTO_STATUS_MSG: 'Hello from SILA MD !',
                AUTO_LIKE_EMOJI: ['❤️', '👍', '😮', '😎']
            };
            
            await pool.query(
                'INSERT INTO user_configs (number, config) VALUES ($1, $2)',
                [cleanNumber, JSON.stringify(defaultConfig)]
            );
            
            return defaultConfig;
        }
    } catch (error) {
        console.error('❌ Error getting user config from PostgreSQL:', error);
        return {};
    }
}

// Update user config
async function updateUserConfigInMongoDB(number, newConfig) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        await pool.query(
            'UPDATE user_configs SET config = $1, updated_at = CURRENT_TIMESTAMP WHERE number = $2',
            [JSON.stringify(newConfig), cleanNumber]
        );
        console.log(`⚙️ Config updated for ${cleanNumber}`);
        return true;
    } catch (error) {
        console.error('❌ Error updating user config in PostgreSQL:', error);
        return false;
    }
}

// Save OTP
async function saveOTPToMongoDB(number, otp, config) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        const expiresAt = new Date();
        expiresAt.setMinutes(expiresAt.getMinutes() + 5); // 5 minutes
        
        await pool.query(
            'INSERT INTO otps (number, otp, config, expires_at) VALUES ($1, $2, $3, $4)',
            [cleanNumber, otp, JSON.stringify(config), expiresAt]
        );
        console.log(`🔐 OTP saved for ${cleanNumber}`);
        return true;
    } catch (error) {
        console.error('❌ Error saving OTP to PostgreSQL:', error);
        return false;
    }
}

// Verify OTP
async function verifyOTPFromMongoDB(number, otp) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        const result = await pool.query(
            'SELECT * FROM otps WHERE number = $1 AND otp = $2 AND expires_at > CURRENT_TIMESTAMP',
            [cleanNumber, otp]
        );
        
        if (result.rows.length === 0) {
            return { valid: false, error: 'Invalid or expired OTP' };
        }
        
        const otpRecord = result.rows[0];
        
        // Delete OTP
        await pool.query('DELETE FROM otps WHERE id = $1', [otpRecord.id]);
        
        return {
            valid: true,
            config: otpRecord.config
        };
    } catch (error) {
        console.error('❌ Error verifying OTP from PostgreSQL:', error);
        return { valid: false, error: 'Verification error' };
    }
}

// Add number to active list
async function addNumberToMongoDB(number) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        await pool.query(
            'UPDATE whatsapp_sessions SET is_active = true, last_connected = CURRENT_TIMESTAMP WHERE number = $1',
            [cleanNumber]
        );
        return true;
    } catch (error) {
        console.error('❌ Error updating number in PostgreSQL:', error);
        return false;
    }
}

// Remove number
async function removeNumberFromMongoDB(number) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        await pool.query(
            'UPDATE whatsapp_sessions SET is_active = false WHERE number = $1',
            [cleanNumber]
        );
        return true;
    } catch (error) {
        console.error('❌ Error removing number from PostgreSQL:', error);
        return false;
    }
}

// Get all active numbers
async function getAllNumbersFromMongoDB() {
    try {
        const result = await pool.query(
            'SELECT number FROM whatsapp_sessions WHERE is_active = true'
        );
        return result.rows.map(row => row.number);
    } catch (error) {
        console.error('❌ Error getting numbers from PostgreSQL:', error);
        return [];
    }
}

// Increment stats
async function incrementStats(number, field) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        const today = new Date().toISOString().split('T')[0];
        
        const fieldMap = {
            commandsUsed: 'commands_used',
            messagesReceived: 'messages_received',
            messagesSent: 'messages_sent',
            groupsInteracted: 'groups_interacted'
        };
        
        const dbField = fieldMap[field] || field;
        
        await pool.query(`
            INSERT INTO stats (number, date, ${dbField}) 
            VALUES ($1, $2, 1)
            ON CONFLICT (number, date) 
            DO UPDATE SET ${dbField} = stats.${dbField} + 1
        `, [cleanNumber, today]);
    } catch (error) {
        console.error('❌ Error updating stats:', error);
    }
}

// Get stats
async function getStatsForNumber(number) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        const result = await pool.query(
            'SELECT * FROM stats WHERE number = $1 ORDER BY date DESC LIMIT 30',
            [cleanNumber]
        );
        return result.rows;
    } catch (error) {
        console.error('❌ Error getting stats:', error);
        return [];
    }
}

// Get user by ID
async function getUserById(userId) {
    try {
        const result = await pool.query(
            'SELECT id, username, email, full_name, created_at, last_login FROM users WHERE id = $1',
            [userId]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('❌ Get user error:', error);
        return null;
    }
}

module.exports = {
    connectdb,
    pool,
    
    // User auth functions
    registerUser,
    loginUser,
    createUserSession,
    validateSessionToken,
    deleteUserSession,
    getUserById,
    getUserWhatsAppNumbers,
    
    // Session functions
    saveSessionToMongoDB,
    getSessionFromMongoDB,
    deleteSessionFromMongoDB,
    
    // Config functions
    getUserConfigFromMongoDB,
    updateUserConfigInMongoDB,
    
    // OTP functions
    saveOTPToMongoDB,
    verifyOTPFromMongoDB,
    
    // Number functions
    addNumberToMongoDB,
    removeNumberFromMongoDB,
    getAllNumbersFromMongoDB,
    
    // Stats functions
    incrementStats,
    getStatsForNumber,
    
    // Legacy aliases
    getUserConfig: getUserConfigFromMongoDB,
    updateUserConfig: updateUserConfigInMongoDB
};
