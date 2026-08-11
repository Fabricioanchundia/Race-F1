pipeline {
    agent any

    tools {
        nodejs 'NodeJS-20-RaceSync'
    }

    triggers {
        pollSCM('H/2 * * * *')
    }

    stages {

        stage('Preparar workspace') {
            steps {
                echo '=== Preparando workspace de RaceSync F1 ==='
                deleteDir()
            }
        }

        stage('Clonar repositorio') {
            steps {
                echo '=== Clonando Race-F1 desde GitHub ==='

                git branch: 'main',
                    url: 'https://github.com/Fabricioanchundia/Race-F1.git'

                sh '''
                    echo "=== Commit analizado ==="
                    git log -1 --oneline

                    echo "=== Rama actual ==="
                    git branch --show-current

                    echo "=== Version de NodeJS ==="
                    node --version

                    echo "=== Version de npm ==="
                    npm --version
                '''
            }
        }

        stage('Validaciones automaticas') {
            steps {
                echo '=== Ejecutando validaciones automaticas ==='

                sh '''
                    echo "=== Validando archivos JavaScript del Gateway ==="
                    find gateway/src -type f -name "*.js" -exec node --check {} \\;

                    echo "=== Validando archivos JavaScript de los Sectores ==="
                    find sector-node/src -type f -name "*.js" -exec node --check {} \\;

                    echo "=== Validando package.json del Gateway ==="
                    node -e "JSON.parse(require('fs').readFileSync('gateway/package.json','utf8')); console.log('gateway/package.json OK')"

                    echo "=== Validando package.json de Sector Node ==="
                    node -e "JSON.parse(require('fs').readFileSync('sector-node/package.json','utf8')); console.log('sector-node/package.json OK')"

                    echo "=== VALIDACIONES AUTOMATICAS COMPLETADAS ==="
                '''
            }
        }

        stage('Preparar SonarQube') {
            steps {
                echo '=== Utilizando configuracion SonarQube versionada en GitHub ==='

                sh '''
                    echo "=== Verificando sonar-project.properties ==="

                    if [ ! -f sonar-project.properties ]; then
                        echo "ERROR: No existe sonar-project.properties"
                        exit 1
                    fi

                    echo "=== Configuracion que utilizara SonarQube ==="
                    cat sonar-project.properties
                '''
            }
        }

        stage('Analisis SonarQube') {
            steps {
                echo '=== Ejecutando analisis SonarQube ==='

                script {
                    def scannerHome = tool 'SonarScanner-RaceSync'

                    withSonarQubeEnv('RaceSync-SonarQube') {
                        sh "${scannerHome}/bin/sonar-scanner"
                    }
                }
            }
        }

        stage('Finalizar') {
            steps {
                echo '========================================='
                echo ' RaceSync F1 - Pipeline CI completado'
                echo ' GitHub + Jenkins + NodeJS + SonarQube'
                echo ' Validaciones automaticas habilitadas'
                echo ' Configuracion SonarQube desde GitHub'
                echo ' Monitoreo automatico de cambios habilitado'
                echo '========================================='
            }
        }
    }

    post {
        success {
            echo 'PIPELINE EJECUTADO CORRECTAMENTE'
        }

        failure {
            echo 'EL PIPELINE HA FALLADO - revisar Console Output'
        }

        always {
            echo '=== Fin del pipeline RaceSync F1 ==='
        }
    }
}