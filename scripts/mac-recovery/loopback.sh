# Sourced after the official image creates its private Tomcat configuration.
# Refuse to start if the pinned image changes its active HTTP connector.
server_xml="$CATALINA_BASE/conf/server.xml"
if [[ "$(grep -c '^[[:space:]]*<Connector port="8080" protocol="HTTP/1.1"' "$server_xml")" != 1 ]]; then
    echo "Unsupported Tomcat connector" >&2
    exit 1
fi
sed -i 's/<Connector port="8080" protocol="HTTP\/1.1"/<Connector address="127.0.0.1" port="18482" protocol="HTTP\/1.1"/' "$server_xml" || exit 1
