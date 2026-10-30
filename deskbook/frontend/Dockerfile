# Single stage, COPY only: the frontend is static HTML + one ES module, no build step.
FROM docker.io/library/nginx:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public /usr/share/nginx/html
