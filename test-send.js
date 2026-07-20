const http = require('http');

const data = JSON.stringify({
  id: 'asisten1',
  phone: '6285173482002',
  message: 'Ini tes kirim dari script lokal'
});

const options = {
  hostname: 'localhost',
  port: 3030,
  path: '/api/send-text',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, res => {
  console.log(`statusCode: ${res.statusCode}`);
  res.on('data', d => {
    process.stdout.write(d);
  });
});

req.on('error', error => {
  console.error(error);
});

req.write(data);
req.end();
