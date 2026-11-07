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

// 4. Route: Save a User (POST)
app.post('/api/users', async (req, res) => {
    try {
        const newUser = new User({ name: req.body.name, email: req.body.email });
        await newUser.save(); 
        res.status(201).json({ message: 'User saved!', user: newUser });
    } catch (error) {
        res.status(500).json({ error: 'Failed to save user' });
    }
});

// 5. Route: Get all Users (GET)
app.get('/api/users', async (req, res) => {
    try {
        const users = await User.find(); 
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: 'Failed to get users' });
    }
});

// 6. Route: Update a User (PUT)
app.put('/api/users/:id', async (req, res) => {
    try {
        const updatedUser = await User.findByIdAndUpdate(
            req.params.id, 
            { name: req.body.name, email: req.body.email },
            { new: true }
        );
        res.json({ message: 'User updated!', user: updatedUser });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update user' });
    }
});

// 7. Route: Delete a User (DELETE)
app.delete('/api/users/:id', async (req, res) => {
    try {
        await User.findByIdAndDelete(req.params.id);
        res.json({ message: 'User deleted successfully!' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
