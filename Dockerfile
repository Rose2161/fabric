FROM node:22.9
WORKDIR /fabric

# if package.json changes. Docker deploys auto-update
COPY package.json /fabric
RUN npm install
RUN npm build
COPY . ./fabric

EXPOSE 9999
CMD ["npm", "start"]
