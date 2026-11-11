FROM docker.io/nginxinc/nginx-unprivileged:1.27-alpine
COPY index.html /usr/share/nginx/html/
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js
COPY data /usr/share/nginx/html/data
COPY vendor /usr/share/nginx/html/vendor
EXPOSE 8080
