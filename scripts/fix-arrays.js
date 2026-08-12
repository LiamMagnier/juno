const fs = require('fs');
let schema = fs.readFileSync('prisma/schema.prisma', 'utf-8');
schema = schema.replace(/String\[\]\s*@default\(\[\]\)/g, 'String @default("[]")');
schema = schema.replace(/Float\[\]\s*@default\(\[\]\)/g, 'String @default("[]")');
fs.writeFileSync('prisma/schema.prisma', schema);
console.log('Fixed arrays.');
