FROM node:22-alpine

# Keep runtime behavior explicit and prevent npm from installing development
# dependencies inside the production-style image.
ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# The image deliberately excludes `.env`, logs, and node_modules through
# `.dockerignore`. Source files belong to the unprivileged runtime user.
COPY --chown=node:node . .
RUN mkdir -p /app/logs && chown node:node /app/logs

# A container should not need root privileges to serve HTTP traffic. The host
# log bind mount remains the only intentionally writable application location.
USER node

EXPOSE 5000

CMD ["npm", "start"]
