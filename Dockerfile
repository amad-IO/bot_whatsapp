FROM node:22-slim

# Install Chromium untuk puppeteer (whatsapp-web.js butuh ini)
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json dan install dependency
COPY package*.json ./
RUN npm install

# Copy seluruh file
COPY . .

# Expose port (default 3030 atau sesuai di .env)
EXPOSE 3030

# Jalanakan server
CMD ["node", "server-new.js"]
