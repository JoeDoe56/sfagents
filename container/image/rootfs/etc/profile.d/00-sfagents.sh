# SF Agents runs commands with bash -lc, and Debian's /etc/profile resets
# PATH. Put SF Agents' commands (sfa-web, sfa-artifact, sfa-git) and the
# toolchains back.
export PATH="/run/sfa/bin:/home/agent/.local/bin:/home/agent/.local/share/pnpm:/home/agent/go/bin:/opt/cargo/bin:/home/agent/.dotnet/tools:/usr/local/go/bin:/opt/gradle/bin:/opt/maven/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
