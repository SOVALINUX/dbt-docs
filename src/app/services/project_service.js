
const angular = require('angular');
const $ = require('jquery');
const _ = require('underscore');

import merge from 'deepmerge';

angular
.module('dbt')
.factory('project', ['$q', '$http', function($q, $http) {

    var TARGET_PATH = '';

    var service = {
        project: {},
        tree: {
            project: [],
            database: []
        },
        files: {
            manifest: {},
            catalog: {},
            run_results: {},
        },

        loaded: $q.defer()
    }

    service.find_by_id = function(uid, cb) {
        service.ready(function() {
            if (uid) {
                var node = service.node(uid);
                cb(node);
            }
        });
    }

    service.node = function(unique_id) {
        return _.find(service.project.nodes, {unique_id: unique_id});
    }

    function match_dict_keys(dest_keys, obj) {
        var new_obj = {};
        _.each(obj, function(value, key) {

            var desired_key = _.find(dest_keys, function(k) {
                return k.toLowerCase() == key.toLowerCase();
            });

            if (!desired_key) {
                new_obj[key] = value;
            } else {
                new_obj[desired_key] = value;
            }

        })

        return new_obj;
    }

    function incorporate_catalog(manifest, catalog) {
        // later elements are preferred in the merge, but it
        // shouldn't matter, as these two don't clobber each other
        _.each(manifest.nodes, function(node, node_id) {
            var catalog_entry = catalog.nodes[node_id];
            if (!catalog_entry) {
                return
            }

            var catalog_column_names = _.keys(catalog_entry.columns);
            var manifest_columns = node.columns;

            var new_columns = match_dict_keys(catalog_column_names, manifest_columns);
            node.columns = new_columns;

        });

        return merge(catalog, manifest)
    }

    function incorporate_run_results(project, run_results) {
        if (!run_results) {
            return project;
        }

        _.each(run_results.results, function(result) {
            var node = result.node;

            if (!node) {
                return
            }

            var unique_id = node.unique_id;
            var injected_sql = node.injected_sql;

            if (project.nodes[unique_id]) {
                project.nodes[unique_id].injected_sql = node.injected_sql;
            }
        });

        return project
    }

    function loadFile(label, path) {
        return $http({
            method: 'GET',
            url: path
        }).then(function(response) {
            return {
                label: label,
                data: response.data
            }
        }, function onError(e) {
            console.error(e);
        })
    }

    service.loadProject = function() {
        var promises = [
            loadFile('manifest', TARGET_PATH + "manifest.json"),
            loadFile('catalog', TARGET_PATH + "catalog.json"),
            loadFile('run_results', TARGET_PATH + "run_results.json"),
        ]

        $q.all(promises).then(function(files) {
            _.each(files, function(file) {
                if (file) {
                    service.files[file.label] = file.data
                } else {
                    console.error("FILE FAILED TO LOAD!");
                }
            });

            var project = incorporate_catalog(service.files.manifest, service.files.catalog);
            var compiled_project = incorporate_run_results(project, service.files.run_results);


            var models = _.where(compiled_project.nodes, {resource_type: 'model'})
            var model_names = _.indexBy(models, 'name');

            var tests = _.where(compiled_project.nodes, {resource_type: 'test'})
            _.each(tests, function(test) {
                if (test.tags.indexOf('schema') == -1 || !test.column_name) {
                    return;
                }

                var test_info = {
                    column: test.column_name,
                };

                if (test.name.startsWith("not_null")) {
                    test_info.label = "Not Null";
                    test_info.short = "N";
                } else if (test.name.startsWith("unique")) {
                    test_info.label = "Unique";
                    test_info.short = "U";
                } else if (test.name.startsWith("relationships")) {
                    test_info.label = "Foreign Key";
                    test_info.short = "F";

                    // hacks
                    if (test.refs.length != 2) {
                        return;
                    } else {
                        var rel_model_name = test.refs[1];
                        var rel_model = model_names[rel_model_name];
                        if (!rel_model) {
                            return;
                        }

                        var field_match = test.raw_sql.match(/field='([a-zA-Z0-9_]*)'/);
                        if (field_match) {
                            test_info.fk_field = field_match[1];
                            test_info.fk_model = rel_model;
                        } else {
                            return
                        }
                    }
                //} else if (test.name.startsWith("accepted_values")) {
                //    test_info.label = "Values";
                //    test_info.short = "A";
                } else {
                    return;
                }

                var depends_on = test.depends_on.nodes;
                if (depends_on.length) {
                    var model = depends_on[0];
                    var node = project.nodes[model];
                    var column = node.columns[test.column_name];

                    if (!column) {
                        return;
                    }

                    column.tests = column.tests || [];
                    column.tests.push(test_info);
                }

            });

            service.project = compiled_project;

            // performance hack
            service.project.searchable = _.filter(service.project.nodes, {resource_type: 'model'});

            service.loaded.resolve();
        });
    }

    service.ready = function(cb) {
        service.loaded.promise.then(function() {
            cb(service.project);
        });
    }

    function fuzzySearchObj(val, obj) {
        var objects = [];
        var search_keys = {'name':null, 'description':null};

        var search = new RegExp(val, "i")

        for (var i in search_keys) {
            if (!obj[i]) {
               continue;
            } else if (obj[i].toLowerCase().indexOf(val.toLowerCase()) != -1) {
                objects.push({key: i, value: val});
            }
        }

        return objects
    }

    service.search = function(q) {
        if (q.length == 0) {
            return _.map(service.project.searchable, function(model) {
                return {
                    model: model,
                    matches: []
                }
            })
        }

        var res = [];
        _.each(service.project.searchable, function(model) {
            var matches = fuzzySearchObj(q, model);
            if (matches.length) {
                res.push({
                    model: model,
                    matches: matches,
                });
            }
        });
        return res;
    }

    service.getModelTree = function(select, cb) {
        service.loaded.promise.then(function() {
            var models = _.filter(service.project.nodes, {resource_type: 'model'});
            service.tree.database = buildDatabaseTree(models, select);
            service.tree.project = buildProjectTree(models, select);
            cb(service.tree);
        });
    }

    service.updateSelectedInTree = function(select, subtrees) {
        var is_active = false;
        _.each(subtrees, function(subtree) {
            if (subtree.node && subtree.node.unique_id == select) {
                subtree.active = true;
                is_active = true;
            } else if (subtree.node && subtree.node.unique_id != select) {
                subtree.active = false;
            } else {
                var child_active = service.updateSelectedInTree(select, subtree.items);
                if (child_active) {
                    subtree.active = true;
                    is_active = true;
                }
            }
        })
        return is_active;
    }

    service.updateSelected = function(select) {
        service.updateSelectedInTree(select, service.tree.project);
        service.updateSelectedInTree(select, service.tree.database);

        return service.tree;
    }

    function recursiveFlattenItems(tree) {
        var res = [];

        var subtrees = _.values(tree);
        _.each(subtrees, function(subtree) {
            if (subtree.items) {
                var flattened = recursiveFlattenItems(subtree.items);
                var sorted = _.sortBy(flattened, 'name')
                subtree.items = sorted;
            }
            res.push(subtree);
        })

        return res;
    }

    function buildProjectTree(nodes, select) {
        var tree = {};

        _.each(nodes, function(node) {
            if (node.original_file_path.indexOf("\\") != -1) {
                var path_parts = node.original_file_path.split("\\");
            } else {
                var path_parts = node.original_file_path.split("/");
            }

            var path = [node.package_name].concat(path_parts);
            var is_active = node.unique_id == select;

            var dirpath = _.initial(path);
            var fname = _.last(path);

            var cur_dir = tree;
            _.each(dirpath, function(dir) {
                if (!cur_dir[dir]) {
                    cur_dir[dir] = {
                        type: 'folder',
                        name: dir,
                        active: is_active,
                        items: {}
                    };
                } else if (is_active) {
                    cur_dir[dir].active = true;
                }
                cur_dir = cur_dir[dir].items;
            })
            cur_dir[fname] = {
                type: 'file',
                name: node.name,
                node: node,
                active: is_active,
                unique_id: node.unique_id,
            }
        });

        var flat = recursiveFlattenItems(tree);
        return flat;
    }

    function buildDatabaseTree(nodes, select) {
        var schemas = {}

        _.each(nodes, function(node) {
            var schema = node.schema;
            var name = node.name;
            var materialized = node.config.materialized;
            var is_active = node.unique_id == select;

            if (materialized == 'ephemeral') {
                return;
            }

            if (!schemas[schema]) {
                schemas[schema] = {
                    type: "schema",
                    name: schema,
                    active: is_active,
                    items: []
                };
            } else if (is_active) {
                schemas[schema].active = true;
            }

            schemas[schema].items.push({
                type: 'table',
                name: node.alias,
                node: node,
                active: is_active,
                unique_id: node.unique_id
            })
        });

        // sort schemas
        var schemas = _.sortBy(_.values(schemas), 'name');

        // sort tables in the schema
        _.each(schemas, function(schema) {
            schema.items = _.sortBy(schema.items, 'name');
        });

        return schemas
    }

    service.init = function() {
        service.loadProject()

        var models = _.filter(service.project.nodes, {resource_type: 'model'});
        service.tree.database = buildDatabaseTree(models);
        service.tree.project = buildProjectTree(models);
    }

    return service;

}]);