const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use((_req, res) => {
  res.status(404).redirect('/');
});

app.listen(PORT, () => console.log(`LNTU calculator running on ${PORT}`));
