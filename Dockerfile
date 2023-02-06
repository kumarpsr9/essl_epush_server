FROM tomcat:8.0-jre8

LABEL maintainer=”kumar@aditya.ac.in”

COPY iclock /usr/local/tomcat/webapps/iclock

EXPOSE 8080

CMD ["catalina.sh", "run"]
