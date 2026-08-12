const fs = require('fs');
let schema = fs.readFileSync('prisma/schema.prisma', 'utf-8');
schema = schema.replace(/provider\s*=\s*"postgresql"/, 'provider = "sqlite"');
schema = schema.replace(/directUrl\s*=\s*env\("DIRECT_URL"\)/, '');
schema = schema.replace(/@db\.Text/g, '');
fs.writeFileSync('prisma/schema.prisma', schema);
console.log('Schema updated to SQLite.');
