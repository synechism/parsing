FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src

EXPOSE 8090

CMD ["npm", "run", "dev:table-agent"]
