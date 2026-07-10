# Lightest-footprint static server: busybox httpd (~1.5 MB base image).
FROM busybox:musl
WORKDIR /www
COPY mush-map-editor.html /www/index.html
COPY css /www/css
COPY js /www/js
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
EXPOSE 80
CMD ["/docker-entrypoint.sh"]
