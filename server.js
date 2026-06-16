const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const cors = require('cors');
const port = process.env.PORT || 3000;

// Create an SQLite database file if it doesn't exist
let db = new sqlite3.Database('./biryani_orders.sqlite', (err) => {
    if (err) return console.error(err.message);
    console.log('Connected to the SQLite file database.');
});

// Initialize the 'Orders' table if it doesn't exist


db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_name TEXT NOT NULL,
        phone_number TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        status TEXT DEFAULT 'Pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Middleware to parse JSON bodies
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// POST route to add a new order
app.post('/orders', (req, res) => {
    const { customer_name, phone_number, quantity } = req.body;

    if (!customer_name || !phone_number || typeof quantity !== 'number' || 
quantity <= 0) {
        return res.status(400).json({ error: 'Invalid input data' });
    }

    db.run(
        `INSERT INTO Orders (customer_name, phone_number, quantity) VALUES 
(?, ?, ?)`,
        [customer_name, phone_number, quantity],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });

            res.json({ id: this.lastID, customer_name, phone_number, 
quantity });
        }
    );
});

app.put('/orders/:id/status', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    const query = `UPDATE orders SET status = ? WHERE id = ?`;
    db.run(query, [status, id], function(err) {
        if (err) {
            console.error('Error updating order status:', err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json({ message: 'Order status updated successfully', updatedId: id });
    });
});

// GET route to retrieve all orders
app.get('/orders', (req, res) => {
    db.all('SELECT * FROM Orders', (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        res.json(rows);
    });
});

// Start the server
app.listen(port, '0.0.0.0', () => {
    console.log(`Server is running on port ${port}`);
});
