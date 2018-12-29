#!/bin/sh

set -e

org="$1"
repo="$2"
defbranch="$3"

[ -z "$defbranch" ] && defbranch="develop"

rm -r "$repo" || true

curbranch="$TRAVIS_PULL_REQUEST_BRANCH"
[ -z "$curbranch" ] && curbranch="$TRAVIS_BRANCH"
[ -z "$curbranch" ] && curbranch=`"echo $GIT_BRANCH" | sed -e 's/^origin\///'` # jenkins

if [ -n "$curbranch" ]
then
    echo "Determined branch to be $curbranch"

    git clone https://github.com/$org/$repo.git $repo --branch "$curbranch" && exit 0
fi

echo "Checking out default branch $defbranch"
git clone https://github.com/$org/$repo.git $repo --branch $defbranch
