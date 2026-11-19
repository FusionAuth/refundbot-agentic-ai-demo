FROM --platform=linux/arm64 node:20-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# tsx runs the TypeScript sources directly, so there is no compile step.
COPY index.ts planner.ts ./

EXPOSE 8080

CMD ["npm", "start"]
