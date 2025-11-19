// const { PrismaClient } = require('@prisma/client');

// const prisma = new PrismaClient();

// module.exports = { prisma };

// prisma.js
const { PrismaClient } = require('@prisma/client');

let prisma = new PrismaClient();

if (process.env.NODE_ENV === 'production') {
} else {
  // Use global cache in development to avoid multiple instances
  if (!global.prisma) {
    global.prisma = new PrismaClient();
  }
  prisma = global.prisma;
}

module.exports = { prisma };