FROM node:22-alpine

LABEL maintainer="kumar@aditya.ac.in"

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# Device punch times are stored in IST; keep the container clock in the same zone.
ENV TZ=Asia/Kolkata
RUN apk add --no-cache tzdata

EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1

CMD ["node", "src/server.js"]
