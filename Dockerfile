
# Node 4.4 on Debian Jessie
FROM node:argon

# Meta
MAINTAINER Ivo Georgiev <ivo@strem.io>
LABEL Description="Stremio Watchhub" Vendor="Smart Code ltd" Version="1.13.3"


# Create app directory
RUN mkdir -p /var/www/watchhub

# install app dependencies
WORKDIR /var/www/watchhub
COPY package.json /var/www/watchhub
RUN npm install --silent 

# Bundle app source
WORKDIR /var/www/watchhub
COPY . /var/www/watchhub

EXPOSE 9005
ENV NODE_ENV production
CMD npm start

