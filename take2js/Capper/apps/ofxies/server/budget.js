var Q = require('q');

function integrationTestMain(process, mysql) {
    var argv = process.argv,
        dbName = argv[2], host = 'localhost',
        acctName = argv[3], since = argv[4];

    makeSecretTool(process.spawn).lookup({
        protocol: 'mysql',
        server: host,
        object: dbName
    }).then(function(password) {
        var budget = makeBudget(makeDB(
            mysql,
            {
                host     : host,
                user     : process.env.LOGNAME,
                password : password,
                database : dbName
            }));

        /*
        budget.subAccounts(acctName).then(function(accts) {
            console.log('subaccounts: ', accts);
        });
        */

        budget.acctBalance(acctName, since).then(function(info) {
            console.log('balance: ', info.balance);
        }).done();
    });
}


function makeSecretTool(spawn) {
    // cribbed from https://github.com/drudge/node-keychain/blob/master/keychain.js
    var toolPath = 'secret-tool';

    function lookup(what) {
        var args = ['lookup'];
        for (var prop in what) {
            args.push(prop);
            args.push(what[prop]);
        }


        // console.log('spawn(', toolPath, args, ')');
        var tool = spawn(toolPath, args);

        var password = '';
        tool.stdout.on('data', function(d) {
            password += d;
        });

        var out = Q.defer();
        tool.on('close', function(code /* , signal */) {
            if (code !== 0) {
                out.reject(new Error('non-zero exit from ' + toolPath));
                return;
            }

            out.resolve(password);
        });

        return out.promise;
    }

    return Object.freeze({
        lookup: lookup,
        path: function() { return toolPath; }
    });
}


function makeDB(mysql, opts) {
    function withConnection(fn) {
        var connection = mysql.createConnection(opts);
        connection.connect(); // ???
        var out = fn(connection);
        connection.end();  // TODO: pooling?
        return out;
    }

    function query(dml, params) {
        return Q.promise(function(resolve, reject) {
            withConnection(function(c) {
                // console.log('DEBUG: db.query: ', dml, params || '');
                c.query(dml, params, function(err, rows) {
                    if (err) return reject(err);
                    // console.log('DEBUG: db.query result: ', rows);
                    resolve(rows);
                });
            });
        });
    }

    return Object.freeze({
        withConnection: withConnection,
        query: query
    });
}



function sqlList(uuids) {
    // TODO: verify uuid syntax to prevent against SQL injection
    return uuids.map(function(u) { return '\'' + u + '\''; }).join(', ');
}


function first(rows) {
    return rows[0];
}


function makeBudget(db) {
    function subAccounts(acctP) {
        var q = ('select child.guid, child.name ' +
                 'from accounts child ' +
                 'join accounts parent on child.parent_guid = parent.guid ' +
                 'where parent.guid in (PARENTS)');

        function recur(parents, generations, resolve, reject) {
            var parentIds = parents.map(function(p) { return p.guid; });
            db.query(q.replace('PARENTS', sqlList(parentIds))).then(
                function(children) {
                    if (children.length == 0) {
                        var acctIds = [].concat.apply([], generations);
                        return resolve(acctIds);
                    }
                    generations.push(children);
                    recur(children, generations, resolve, reject);
                }, reject);
        }

        return Q.promise(function(resolve, reject) {
            acctP.then(function(acct) {
                recur([acct], [[acct]], resolve, reject);
            }, reject);
        });
    }

    function acctBalance(acctName, since) {
        var q = ('select sum(value_num / value_denom) balance ' +
                 '  , ? name, ? since ' +
                 'from splits s ' +
                 'join accounts a on a.guid = s.account_guid ' +
                 'join transactions tx on tx.guid = s.tx_guid ' +
                 'where a.guid in (SUBACCOUNTS) ' +
                 'and tx.post_date >= ?');

        return subAccounts(acctByName(acctName)).then(function(accts) {
            var acctIds = accts.map(function(a) { return a.guid; });
            return db.query(q.replace('SUBACCOUNTS', sqlList(acctIds)),
                            [acctName, since, since])
                .then(first);
        });
    }

    function acctByName(acctName) {
        return db.query(
            'select guid, name from accounts where name = ?',
            [acctName])
            .then(first);
    }

    return Object.freeze({
        subAccounts: function(acctName) {
            return subAccounts(acctByName(acctName));
        },
        acctBalance: acctBalance
    });
}

integrationTestMain(
    {
        argv: process.argv,
        env: process.env,
        spawn: require('child_process').spawn
    },
    require('mysql'));
