FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data TZ_NAME=Asia/Tokyo
COPY package.json ./
COPY src ./src
COPY public ./public
VOLUME ["/data"]
EXPOSE 8787
CMD ["npm", "start"]
