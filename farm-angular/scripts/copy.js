// ينسخ ناتج بناء Angular إلى server/public علشان السيرفر يقدمه
const fs = require('fs'), path = require('path');
const from = path.join(__dirname, '..', 'dist', 'farm', 'browser'), to = path.join(__dirname, '..', 'server', 'public');
if (!fs.existsSync(from)) { console.error('مفيش بناء. شغّل ng build الأول'); process.exit(1); }
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
console.log('تم النسخ إلى server/public');
