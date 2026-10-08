#!/bin/bash
# Empty the eSSL error log at midnight IST every day so it doesn't grow forever.
# The file is truncated in place (not deleted/replaced) because docker-compose
# bind-mounts it from the host; a new file would detach the mount.
# TZ is set only for `date` here so the JVM's timezone is left untouched.
LOG_FILE=/usr/local/tomcat/webapps/iclock/WEB-INF/logfile.txt

(
  while true; do
    read -r h m s <<< "$(TZ=IST-5:30 date +'%H %M %S')"
    sleep $(( 86400 - (10#$h * 3600 + 10#$m * 60 + 10#$s) ))
    : > "$LOG_FILE"
  done
) &

exec catalina.sh run
