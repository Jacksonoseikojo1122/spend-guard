# Runs the MCP server (stdio). Set SPEND_GUARD_URL and SPEND_GUARD_AGENT_KEY to point it at
# your Spend Guard; without them it starts and lists its tools, but can't pay anything.
# For the HTTP API itself, override the command: docker run ... npm start
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY openapi.yaml llms.txt ./
CMD ["npx", "tsx", "src/mcp-stdio.ts"]
