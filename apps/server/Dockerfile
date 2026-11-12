FROM node:20-alpine

WORKDIR /app

# ffmpeg readies uploaded videos for streaming and makes their previews,
# thumbnails and scrub frames (src/recordings/).
RUN apk add --no-cache ffmpeg

COPY package.json package-lock.json ./
RUN npm install

COPY . .

EXPOSE 4000

CMD ["npm", "run", "dev"]
