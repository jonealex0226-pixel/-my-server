const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// 1. Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB successfully!'))
  .catch((err) => console.error('❌ MongoDB connection error:', err));

// 2. Create a Database Model
const User = mongoose.model('User', {
    name: String,
    email: String
});

// 3. Route: Health Check
app.get('/api/health', (req, res) => {
    res.json({ status: 'success', message: 'Server and Database are running!' });
});

// 4. Route: Save a User to the Database (POST)
app.post('/api/users', async (req, res) => {
    try {
        const newUser = new User({
            name: req.body.name,
            email: req.body.email
        });
        await newUser.save(); 
        res.status(201).json({ message: 'User saved to database!', user: newUser });
    } catch (error) {
        res.status(500).json({ error: 'Failed to save user' });
    }
});

// 5. Route: Get all Users from Database (GET)
app.get('/api/users', async (req, res) => {
    try {
        const users = await User.find(); 
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get users' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
