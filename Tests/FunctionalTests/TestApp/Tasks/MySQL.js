var Config = require("../Config");
var mysql = require('mysql');

var ready = false;
var connection = null;

function connect() {
    connection = mysql.createConnection(Config.MySqlConnectionString);
    connection.connect((err) => {
        if (!err) {
            connection.query(`
CREATE TABLE IF NOT EXISTS 'test_table' (
'id' int(11) NOT NULL auto_increment,
'data' varchar(100) NOT NULL default '',
PRIMARY KEY  ('id')
);`, (err) => {
                    ready = true;
                });
        } else {
            setTimeout(connect, 100);
        }
    });
}
connect();

function query(callback) {
    if (!ready) {
        setTimeout(() => query(callback), 50);
        return;
    }

    connection.query(`SELECT * FROM 'test_table'`, () => callback());
}


module.exports = {
    query: query
}