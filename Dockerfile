# Lightest-footprint static server: busybox httpd (~1.5 MB base image).
FROM busybox:musl
WORKDIR /www
COPY mush-map-editor.html /www/index.html
COPY css /www/css
COPY js /www/js
EXPOSE 80
CMD ["httpd", "-f", "-v", "-p", "80", "-h", "/www"]
