FROM tomcat:9.0-jre8

LABEL maintainer=”kumar@aditya.ac.in”

# The eSSL servlet hands requests to its own thread pool and those workers keep
# writing to the HttpServletResponse after Tomcat has finished the request
# ("Encountered a non-recycled response and recycled it forcedly"). On Tomcat 8.0/APR
# that late write corrupts the next request reusing the same response object, and the
# connectors eventually hang. RECYCLE_FACADES gives every request a fresh facade so a
# late write fails in the stray thread instead of leaking into another request.
# ExitOnOutOfMemoryError lets `restart: always` recover the container instead of
# leaving a half-dead JVM.
ENV CATALINA_OPTS="-Dorg.apache.catalina.connector.RECYCLE_FACADES=true \
 -XX:+ExitOnOutOfMemoryError \
 -Xms256m -Xmx1024m"

COPY iclock /usr/local/tomcat/webapps/iclock
COPY start.sh /usr/local/bin/start.sh

EXPOSE 8080

CMD ["/usr/local/bin/start.sh"]
