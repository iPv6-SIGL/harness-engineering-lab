# Single stage, COPY only: the frontend is static HTML + one ES module, no build step.
# nginx.conf is a template: the entrypoint injects the network's DNS resolver so
# the API name is re-resolved at runtime (restarts, replicas).
FROM docker.io/library/nginx:1.29-alpine
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY public /usr/share/nginx/html
