# 壁纸精选后端 - 容器镜像
FROM node:20-alpine

WORKDIR /app

# 先装依赖（利用镜像层缓存）
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# 再复制源码（.dockerignore 已排除 node_modules / .env / .git）
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
