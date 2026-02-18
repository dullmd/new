const mongoose = require('mongoose');
const config = require('../config');
const bcrypt = require('bcrypt');

const connectdb = async () => {
    try {
        mongoose.set('strictQuery', false);
        await mongoose.connect(config.MONGODB_URI, {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        });
        console.log("✅ MongoDB Connected Successfully");
        
        // Create indexes
        await createIndexes();
    } catch (e) {
        console.error("❌ MongoDB Connection Failed:", e.message);
        process.exit(1);
    }
};

const createIndexes = async () => {
    try {
        await Session.collection.createIndex({ number: 1 }, { unique: true });
        await User.collection.createIndex({ username: 1 }, { unique: true });
        await User.collection.createIndex({ email: 1 });
        await ActiveNumber.collection.createIndex({ number: 1 }, { unique: true });
        await OTP.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
        console.log("✅ Database indexes created");
    } catch (e) {
        console.error("❌ Error creating indexes:", e.message);
    }
};

// ====================================
// SCHEMAS
// ====================================

// Users (for web login)
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    email: String,
    full_name: String,
    role: { type: String, default: 'user' }, // 'user' or 'admin'
    created_at: { type: Date, default: Date.now },
    last_login: Date
});

// WhatsApp Sessions
const sessionSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    credentials: { type: Object, required: true },
    is_active: { type: Boolean, default: true },
    bot_config: { type: Object, default: {} },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
    last_connected: Date
});

// User Config (per number)
const userConfigSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true },
    config: {
        AUTO_RECORDING: { type: String, default: 'false' },
        AUTO_TYPING: { type: String, default: 'false' },
        ANTI_CALL: { type: String, default: 'false' },
        REJECT_MSG: { type: String, default: '*🔕 Your call was automatically rejected..!*' },
        READ_MESSAGE: { type: String, default: 'false' },
        AUTO_VIEW_STATUS: { type: String, default: 'false' },
        AUTO_LIKE_STATUS: { type: String, default: 'false' },
        AUTO_STATUS_REPLY: { type: String, default: 'false' },
        AUTO_STATUS_MSG: { type: String, default: 'Hello from SILA MD !' },
        AUTO_LIKE_EMOJI: { type: Array, default: ['❤️', '👍', '😮', '😎'] },
        CHATBOT_ENABLED: { type: String, default: 'false' }
    },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
});

// OTP
const otpSchema = new mongoose.Schema({
    number: { type: String, required: true },
    otp: { type: String, required: true },
    config: { type: Object, required: true },
    expires_at: { type: Date, default: () => new Date(Date.now() + 5 * 60000) },
    created_at: { type: Date, default: Date.now }
});

// Active Numbers
const activeNumberSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true },
    last_connected: { type: Date, default: Date.now },
    is_active: { type: Boolean, default: true }
});

// Stats
const statsSchema = new mongoose.Schema({
    number: { type: String, required: true },
    date: { type: String, required: true },
    commands_used: { type: Number, default: 0 },
    messages_received: { type: Number, default: 0 },
    messages_sent: { type: Number, default: 0 },
    groups_interacted: { type: Number, default: 0 }
});

// Web Sessions (for login)
const webSessionSchema = new mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    session_token: { type: String, required: true, unique: true },
    ip_address: String,
    user_agent: String,
    created_at: { type: Date, default: Date.now },
    expires_at: { type: Date, required: true }
});

// ====================================
// MODELS
// ====================================

const User = mongoose.model('User', userSchema);
const Session = mongoose.model('Session', sessionSchema);
const UserConfig = mongoose.model('UserConfig', userConfigSchema);
const OTP = mongoose.model('OTP', otpSchema);
const ActiveNumber = mongoose.model('ActiveNumber', activeNumberSchema);
const Stats = mongoose.model('Stats', statsSchema);
const WebSession = mongoose.model('WebSession', webSessionSchema);

// ====================================
// USER AUTH FUNCTIONS
// ====================================

async function registerUser(username, password, email = null, fullName = null) {
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await User.create({
            username,
            password: hashedPassword,
            email,
            full_name: fullName,
            role: 'user'
        });
        return { success: true, user: { id: user._id, username: user.username } };
    } catch (error) {
        if (error.code === 11000) {
            return { success: false, error: 'Username already exists' };
        }
        console.error('❌ Register error:', error);
        return { success: false, error: 'Registration failed' };
    }
}

async function loginUser(username, password) {
    try {
        const user = await User.findOne({ username });
        if (!user) return { success: false, error: 'Invalid username or password' };

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return { success: false, error: 'Invalid username or password' };

        await User.updateOne({ _id: user._id }, { last_login: new Date() });

        return {
            success: true,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                full_name: user.full_name,
                role: user.role
            }
        };
    } catch (error) {
        console.error('❌ Login error:', error);
        return { success: false, error: 'Login failed' };
    }
}

async function createUserSession(userId, sessionToken, ipAddress, userAgent) {
    try {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);

        await WebSession.create({
            user_id: userId,
            session_token: sessionToken,
            ip_address: ipAddress,
            user_agent: userAgent,
            expires_at: expiresAt
        });
        return { success: true };
    } catch (error) {
        console.error('❌ Create session error:', error);
        return { success: false };
    }
}

async function validateSessionToken(sessionToken) {
    try {
        const session = await WebSession.findOne({
            session_token: sessionToken,
            expires_at: { $gt: new Date() }
        }).populate('user_id');

        if (!session) return { valid: false };

        return { valid: true, user: session.user_id };
    } catch (error) {
        console.error('❌ Validate session error:', error);
        return { valid: false };
    }
}

async function deleteUserSession(sessionToken) {
    try {
        await WebSession.deleteOne({ session_token: sessionToken });
        return { success: true };
    } catch (error) {
        console.error('❌ Delete session error:', error);
        return { success: false };
    }
}

async function getUserById(userId) {
    try {
        return await User.findById(userId).select('-password');
    } catch (error) {
        console.error('❌ Get user error:', error);
        return null;
    }
}

async function getUserWhatsAppNumbers(userId) {
    try {
        return await Session.find({ user_id: userId }).select('number is_active bot_config last_connected');
    } catch (error) {
        console.error('❌ Get user numbers error:', error);
        return [];
    }
}

// ====================================
// ADMIN FUNCTIONS
// ====================================

async function getAllUsers() {
    try {
        return await User.find().select('-password').sort({ created_at: -1 });
    } catch (error) {
        console.error('❌ Get all users error:', error);
        return [];
    }
}

async function getAllSessions() {
    try {
        return await Session.find().populate('user_id', 'username').sort({ created_at: -1 });
    } catch (error) {
        console.error('❌ Get all sessions error:', error);
        return [];
    }
}

async function adminDeleteSession(number) {
    try {
        await Session.deleteOne({ number });
        await UserConfig.deleteOne({ number });
        await ActiveNumber.deleteOne({ number });
        await Stats.deleteMany({ number });
        return { success: true };
    } catch (error) {
        console.error('❌ Admin delete session error:', error);
        return { success: false };
    }
}

async function adminDeleteUser(userId) {
    try {
        const sessions = await Session.find({ user_id: userId });
        for (const session of sessions) {
            await adminDeleteSession(session.number);
        }
        await User.deleteOne({ _id: userId });
        await WebSession.deleteMany({ user_id: userId });
        return { success: true };
    } catch (error) {
        console.error('❌ Admin delete user error:', error);
        return { success: false };
    }
}

// ====================================
// SESSION FUNCTIONS
// ====================================

async function saveSessionToMongoDB(number, credentials, userId = null) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        
        await Session.findOneAndUpdate(
            { number: cleanNumber },
            {
                credentials,
                user_id: userId,
                updated_at: new Date(),
                last_connected: new Date()
            },
            { upsert: true, new: true }
        );
        
        console.log(`📁 Session saved to MongoDB for ${cleanNumber}`);
        return true;
    } catch (error) {
        console.error('❌ Error saving session:', error);
        return false;
    }
}

async function getSessionFromMongoDB(number) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        const session = await Session.findOne({ number: cleanNumber });
        return session ? session.credentials : null;
    } catch (error) {
        console.error('❌ Error getting session:', error);
        return null;
    }
}

async function deleteSessionFromMongoDB(number) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        await Session.deleteOne({ number: cleanNumber });
        await UserConfig.deleteOne({ number: cleanNumber });
        await ActiveNumber.deleteOne({ number: cleanNumber });
        console.log(`🗑️ Session deleted from MongoDB for ${cleanNumber}`);
        return true;
    } catch (error) {
        console.error('❌ Error deleting session:', error);
        return false;
    }
}

// ====================================
// USER CONFIG FUNCTIONS
// ====================================

async function getUserConfigFromMongoDB(number) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        let config = await UserConfig.findOne({ number: cleanNumber });
        
        if (!config) {
            const defaultConfig = {
                AUTO_RECORDING: 'false',
                AUTO_TYPING: 'false',
                ANTI_CALL: 'false',
                REJECT_MSG: '*🔕 Your call was automatically rejected..!*',
                READ_MESSAGE: 'false',
                AUTO_VIEW_STATUS: 'false',
                AUTO_LIKE_STATUS: 'false',
                AUTO_STATUS_REPLY: 'false',
                AUTO_STATUS_MSG: 'Hello from SILA MD !',
                AUTO_LIKE_EMOJI: ['❤️', '👍', '😮', '😎'],
                CHATBOT_ENABLED: 'false'
            };
            
            config = await UserConfig.create({
                number: cleanNumber,
                config: defaultConfig
            });
        }
        
        return config.config;
    } catch (error) {
        console.error('❌ Error getting user config:', error);
        return {};
    }
}

async function updateUserConfigInMongoDB(number, newConfig) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        await UserConfig.findOneAndUpdate(
            { number: cleanNumber },
            { config: newConfig, updated_at: new Date() },
            { upsert: true, new: true }
        );
        console.log(`⚙️ Config updated for ${cleanNumber}`);
        return true;
    } catch (error) {
        console.error('❌ Error updating user config:', error);
        return false;
    }
}

// ====================================
// OTP FUNCTIONS
// ====================================

async function saveOTPToMongoDB(number, otp, config) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        await OTP.create({
            number: cleanNumber,
            otp,
            config,
            expires_at: new Date(Date.now() + 5 * 60000)
        });
        console.log(`🔐 OTP saved for ${cleanNumber}`);
        return true;
    } catch (error) {
        console.error('❌ Error saving OTP:', error);
        return false;
    }
}

async function verifyOTPFromMongoDB(number, otp) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        const otpRecord = await OTP.findOne({
            number: cleanNumber,
            otp,
            expires_at: { $gt: new Date() }
        });
        
        if (!otpRecord) {
            return { valid: false, error: 'Invalid or expired OTP' };
        }
        
        await OTP.deleteOne({ _id: otpRecord._id });
        
        return {
            valid: true,
            config: otpRecord.config
        };
    } catch (error) {
        console.error('❌ Error verifying OTP:', error);
        return { valid: false, error: 'Verification error' };
    }
}

// ====================================
// ACTIVE NUMBERS FUNCTIONS
// ====================================

async function addNumberToMongoDB(number) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        await ActiveNumber.findOneAndUpdate(
            { number: cleanNumber },
            { last_connected: new Date(), is_active: true },
            { upsert: true, new: true }
        );
        return true;
    } catch (error) {
        console.error('❌ Error adding number:', error);
        return false;
    }
}

async function removeNumberFromMongoDB(number) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        await ActiveNumber.deleteOne({ number: cleanNumber });
        return true;
    } catch (error) {
        console.error('❌ Error removing number:', error);
        return false;
    }
}

async function getAllNumbersFromMongoDB() {
    try {
        const activeNumbers = await ActiveNumber.find({ is_active: true });
        return activeNumbers.map(num => num.number);
    } catch (error) {
        console.error('❌ Error getting numbers:', error);
        return [];
    }
}

// ====================================
// STATS FUNCTIONS
// ====================================

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
        
        await Stats.findOneAndUpdate(
            { number: cleanNumber, date: today },
            { $inc: { [dbField]: 1 } },
            { upsert: true, new: true }
        );
    } catch (error) {
        console.error('❌ Error updating stats:', error);
    }
}

async function getStatsForNumber(number) {
    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        return await Stats.find({ number: cleanNumber }).sort({ date: -1 }).limit(30);
    } catch (error) {
        console.error('❌ Error getting stats:', error);
        return [];
    }
}

// ====================================
// EXPORTS
// ====================================

module.exports = {
    connectdb,
    
    // User auth
    registerUser,
    loginUser,
    createUserSession,
    validateSessionToken,
    deleteUserSession,
    getUserById,
    getUserWhatsAppNumbers,
    
    // Admin
    getAllUsers,
    getAllSessions,
    adminDeleteSession,
    adminDeleteUser,
    
    // Session
    saveSessionToMongoDB,
    getSessionFromMongoDB,
    deleteSessionFromMongoDB,
    
    // User Config
    getUserConfigFromMongoDB,
    updateUserConfigInMongoDB,
    
    // OTP
    saveOTPToMongoDB,
    verifyOTPFromMongoDB,
    
    // Active Numbers
    addNumberToMongoDB,
    removeNumberFromMongoDB,
    getAllNumbersFromMongoDB,
    
    // Stats
    incrementStats,
    getStatsForNumber,
    
    // Legacy
    getUserConfig: getUserConfigFromMongoDB,
    updateUserConfig: updateUserConfigInMongoDB
};
