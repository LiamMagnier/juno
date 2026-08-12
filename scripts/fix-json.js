const fs = require('fs');
let schema = fs.readFileSync('prisma/schema.prisma', 'utf-8');
schema = schema.replace(/Json(\?)?/g, 'String$1');
fs.writeFileSync('prisma/schema.prisma', schema);
console.log('Fixed JSON.');
